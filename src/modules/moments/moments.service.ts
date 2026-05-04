import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';

import { MediaService } from '../media/media.service';
import { User, UserDocument } from '../users/schemas/user.schema';
import {
  CommentStatus,
  MomentComment,
  MomentCommentDocument,
} from './schemas/moment-comment.schema';
import {
  MomentLike,
  MomentLikeDocument,
  ReactionKind,
} from './schemas/moment-like.schema';
import {
  Moment,
  MomentDocument,
  MomentStatus,
} from './schemas/moment.schema';

interface ListFeedParams {
  page?: number;
  limit?: number;
  authorId?: string;
}

@Injectable()
export class MomentsService {
  private readonly logger = new Logger(MomentsService.name);

  constructor(
    @InjectModel(Moment.name) private readonly momentModel: Model<MomentDocument>,
    @InjectModel(MomentLike.name)
    private readonly likeModel: Model<MomentLikeDocument>,
    @InjectModel(MomentComment.name)
    private readonly commentModel: Model<MomentCommentDocument>,
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly media: MediaService,
  ) {}

  // ============== Author-side ==============

  async create(authorId: string, input: any): Promise<MomentDocument> {
    if (!Types.ObjectId.isValid(authorId)) {
      throw new BadRequestException({ code: 'INVALID_USER_ID', message: 'Invalid user' });
    }
    const text = (input.text ?? '').trim();
    const media = (input.media ?? []) as Array<Record<string, unknown>>;
    if (text.length === 0 && media.length === 0) {
      throw new BadRequestException({
        code: 'EMPTY_MOMENT',
        message: 'Moment must have text or at least one image',
      });
    }
    const created = await this.momentModel.create({
      authorId: new Types.ObjectId(authorId),
      text,
      media,
      status: MomentStatus.ACTIVE,
    });
    // Re-fetch with author populated so the mobile feed card can
    // render avatar + display name immediately after the optimistic
    // insert. Without this, the response has `authorId` as a bare
    // ObjectId string and the card falls back to "User · just now"
    // until the next feed refresh.
    const populated = await this.momentModel
      .findById(created._id)
      .populate('authorId', 'username displayName avatarUrl numericId level isHost')
      .exec();
    return populated ?? created;
  }

  /** Author or admin can delete; users can only delete their own. */
  async deleteOwn(momentId: string, userId: string): Promise<void> {
    const m = await this.getByIdOrThrow(momentId);
    if (m.authorId.toString() !== userId) {
      throw new ForbiddenException({
        code: 'NOT_AUTHOR',
        message: 'You can only delete your own moments',
      });
    }
    m.status = MomentStatus.DELETED;
    await m.save();
    // Best-effort cleanup of Cloudinary assets — don't block the response.
    for (const piece of m.media) {
      if (piece.publicId) {
        this.media.deleteImage(piece.publicId).catch(() => undefined);
      }
    }
  }

  // ============== Feed (user-facing) ==============

  /**
   * Public feed. For now: most-recent active posts, optionally filtered
   * to a single author. Follower-only / interest-graph ranking lands when
   * the social graph is built.
   */
  async listFeed(viewerId: string | null, params: ListFeedParams) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(50, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const filter: FilterQuery<MomentDocument> = { status: MomentStatus.ACTIVE };
    if (params.authorId && Types.ObjectId.isValid(params.authorId)) {
      filter.authorId = new Types.ObjectId(params.authorId);
    }

    const [items, total] = await Promise.all([
      this.momentModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('authorId', 'username displayName avatarUrl numericId level isHost')
        .exec(),
      this.momentModel.countDocuments(filter).exec(),
    ]);

    // Per-row annotations:
    //   • `myReaction` — the kind the logged-in viewer picked, or null.
    //     Drives which emoji the reaction button shows + whether to
    //     treat the next tap as toggle-off.
    //   • `reactionCounts` — { like: N, love: N, … } so the card can
    //     render an emoji rollup ("👍❤️😂  124") without an extra round
    //     trip per row.
    //   • `likedByMe` — kept for backwards compat with older clients;
    //     true iff `myReaction` is set to anything.
    //
    // Both annotations are computed in a single aggregation across
    // the whole page so we don't N+1 the like collection.
    const momentIds = items.map((m) => m._id);
    const reactionsByMoment = new Map<string, Record<ReactionKind, number>>();
    if (momentIds.length > 0) {
      const counts = await this.likeModel
        .aggregate<{
          _id: { momentId: Types.ObjectId; kind: ReactionKind };
          count: number;
        }>([
          { $match: { momentId: { $in: momentIds } } },
          { $group: { _id: { momentId: '$momentId', kind: '$kind' }, count: { $sum: 1 } } },
        ])
        .exec();
      for (const row of counts) {
        const id = row._id.momentId.toString();
        const bucket =
          reactionsByMoment.get(id) ?? this.emptyReactionBucket();
        // Tolerate legacy rows with missing `kind` — treat as `like`.
        const kind = row._id.kind ?? ReactionKind.LIKE;
        bucket[kind] = (bucket[kind] ?? 0) + row.count;
        reactionsByMoment.set(id, bucket);
      }
    }

    let myReactionByMoment = new Map<string, ReactionKind>();
    if (viewerId && Types.ObjectId.isValid(viewerId) && momentIds.length > 0) {
      const mine = await this.likeModel
        .find({
          userId: new Types.ObjectId(viewerId),
          momentId: { $in: momentIds },
        })
        .select('momentId kind')
        .exec();
      myReactionByMoment = new Map(
        mine.map((l) => [l.momentId.toString(), l.kind ?? ReactionKind.LIKE]),
      );
    }

    // Recent reactors preview — top 3 most recent likes per moment, with
    // user info hydrated. Drives the avatar rollup on the feed card.
    // Single aggregation across the whole page so we don't N+1 the
    // like collection: $sort by createdAt desc, $group → first 3 per
    // moment, then $lookup the user docs.
    const recentReactorsByMoment = new Map<
      string,
      Array<{
        userId: string;
        kind: ReactionKind;
        user: {
          id: string;
          displayName: string;
          username: string;
          avatarUrl: string;
          numericId: number | null;
        } | null;
      }>
    >();
    if (momentIds.length > 0) {
      const recents = await this.likeModel
        .aggregate<{
          _id: Types.ObjectId;
          reactors: Array<{
            userId: Types.ObjectId;
            kind: ReactionKind;
            createdAt: Date;
          }>;
        }>([
          { $match: { momentId: { $in: momentIds } } },
          { $sort: { createdAt: -1 } },
          {
            $group: {
              _id: '$momentId',
              reactors: {
                $push: {
                  userId: '$userId',
                  kind: '$kind',
                  createdAt: '$createdAt',
                },
              },
            },
          },
          {
            $project: {
              reactors: { $slice: ['$reactors', 3] },
            },
          },
        ])
        .exec();
      // Collect every userId we need to hydrate, do one $in lookup.
      const userIds = new Set<string>();
      for (const r of recents) {
        for (const x of r.reactors) userIds.add(x.userId.toString());
      }
      const userDocs = userIds.size
        ? await this.userModel
            .find({
              _id: { $in: Array.from(userIds).map((s) => new Types.ObjectId(s)) },
            })
            .select('username displayName avatarUrl numericId')
            .lean()
            .exec()
        : [];
      const userMap = new Map<string, (typeof userDocs)[number]>();
      for (const u of userDocs) userMap.set(u._id.toString(), u);
      for (const r of recents) {
        recentReactorsByMoment.set(
          r._id.toString(),
          r.reactors.map((x) => {
            const u = userMap.get(x.userId.toString());
            return {
              userId: x.userId.toString(),
              kind: x.kind ?? ReactionKind.LIKE,
              user: u
                ? {
                    id: u._id.toString(),
                    displayName: u.displayName ?? '',
                    username: u.username ?? '',
                    avatarUrl: u.avatarUrl ?? '',
                    numericId: u.numericId ?? null,
                  }
                : null,
            };
          }),
        );
      }
    }

    const annotated = items.map((m) => {
      const json = m.toJSON() as Record<string, unknown>;
      const id = m._id.toString();
      const my = myReactionByMoment.get(id);
      json.myReaction = my ?? null;
      json.likedByMe = my != null;
      json.reactionCounts =
        reactionsByMoment.get(id) ?? this.emptyReactionBucket();
      json.recentReactors = recentReactorsByMoment.get(id) ?? [];
      return json;
    });

    return { items: annotated, page, limit, total };
  }

  /** Zeroed counter map. Used as the default for moments with no
   *  reactions yet so the client sees a complete shape, not a
   *  sometimes-empty object. */
  private emptyReactionBucket(): Record<ReactionKind, number> {
    return {
      [ReactionKind.LIKE]: 0,
      [ReactionKind.LOVE]: 0,
      [ReactionKind.HAHA]: 0,
      [ReactionKind.WOW]: 0,
      [ReactionKind.SAD]: 0,
      [ReactionKind.ANGRY]: 0,
    };
  }

  /**
   * Paginated reactors list — drives the bottom-sheet that opens when
   * the user taps the avatar rollup on a feed card. Newest reactor
   * first, with each user's display info + the kind they picked.
   */
  async listReactors(
    momentId: string,
    params: { page?: number; limit?: number },
  ) {
    if (!Types.ObjectId.isValid(momentId)) {
      throw new BadRequestException({
        code: 'INVALID_MOMENT_ID',
        message: 'Invalid moment id',
      });
    }
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 30));
    const skip = (page - 1) * limit;

    const filter = { momentId: new Types.ObjectId(momentId) };
    const [items, total] = await Promise.all([
      this.likeModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate(
          'userId',
          'username displayName avatarUrl numericId level isHost',
        )
        .lean()
        .exec(),
      this.likeModel.countDocuments(filter).exec(),
    ]);

    const rows = items.map((l) => {
      const u = l.userId as unknown as {
        _id: Types.ObjectId;
        username?: string;
        displayName?: string;
        avatarUrl?: string;
        numericId?: number | null;
        level?: number | null;
      } | null;
      return {
        userId: u?._id.toString() ?? '',
        kind: l.kind ?? ReactionKind.LIKE,
        user: u
          ? {
              id: u._id.toString(),
              displayName: u.displayName ?? '',
              username: u.username ?? '',
              avatarUrl: u.avatarUrl ?? '',
              numericId: u.numericId ?? null,
              level: u.level ?? 1,
            }
          : null,
      };
    });
    return { items: rows, page, limit, total };
  }

  // ============== Reactions ==============

  /**
   * Set or update the viewer's reaction on a moment. Upsert semantics
   * — a user switching from `like` → `love` updates the same row, so
   * the `likeCount` (now treated as "total reactions") only bumps on
   * the FIRST reaction this user adds, not on each kind change.
   */
  async react(
    momentId: string,
    userId: string,
    kind: ReactionKind,
  ): Promise<{ likeCount: number; myReaction: ReactionKind }> {
    if (!Types.ObjectId.isValid(momentId) || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({ code: 'INVALID_ID', message: 'Invalid id' });
    }
    const moment = await this.getByIdOrThrow(momentId);
    if (moment.status !== MomentStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'MOMENT_INACTIVE',
        message: 'Cannot react to an inactive moment',
      });
    }

    const wasNew = await this.upsertReaction(
      moment._id.toString(),
      userId,
      kind,
    );
    if (wasNew) {
      await this.momentModel
        .updateOne({ _id: moment._id }, { $inc: { likeCount: 1 } })
        .exec();
    }
    const fresh = await this.momentModel
      .findById(moment._id)
      .select('likeCount')
      .exec();
    return {
      likeCount: fresh?.likeCount ?? moment.likeCount,
      myReaction: kind,
    };
  }

  /** Backwards-compatible alias — old clients call `like()` without a
   *  reaction kind. Falls through to `react()` with kind=`like`. */
  async like(momentId: string, userId: string): Promise<{ likeCount: number }> {
    const r = await this.react(momentId, userId, ReactionKind.LIKE);
    return { likeCount: r.likeCount };
  }

  /** Clears the viewer's reaction on a moment, if any. */
  async unlike(momentId: string, userId: string): Promise<{ likeCount: number }> {
    if (!Types.ObjectId.isValid(momentId) || !Types.ObjectId.isValid(userId)) {
      throw new BadRequestException({ code: 'INVALID_ID', message: 'Invalid id' });
    }
    const moment = await this.getByIdOrThrow(momentId);
    const res = await this.likeModel
      .deleteOne({
        momentId: new Types.ObjectId(momentId),
        userId: new Types.ObjectId(userId),
      })
      .exec();
    if (res.deletedCount === 1) {
      await this.momentModel
        .updateOne(
          { _id: moment._id, likeCount: { $gt: 0 } },
          { $inc: { likeCount: -1 } },
        )
        .exec();
    }
    const fresh = await this.momentModel
      .findById(moment._id)
      .select('likeCount')
      .exec();
    return { likeCount: fresh?.likeCount ?? moment.likeCount };
  }

  /** Internal upsert helper. Returns true iff a brand-new reaction
   *  row was created (so the caller can bump `likeCount`). False
   *  means the user already had a reaction; only `kind` changed. */
  private async upsertReaction(
    momentId: string,
    userId: string,
    kind: ReactionKind,
  ): Promise<boolean> {
    const result = await this.likeModel
      .updateOne(
        {
          momentId: new Types.ObjectId(momentId),
          userId: new Types.ObjectId(userId),
        },
        { $set: { kind } },
        { upsert: true },
      )
      .exec();
    // `upsertedCount === 1` on insert; `matchedCount === 1` on
    // update of an existing row.
    return result.upsertedCount === 1;
  }

  // ============== Admin moderation ==============

  async listAdmin(params: { page?: number; limit?: number; status?: MomentStatus }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 30));
    const skip = (page - 1) * limit;
    const filter: FilterQuery<MomentDocument> = {};
    if (params.status) filter.status = params.status;
    const [items, total] = await Promise.all([
      this.momentModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('authorId', 'username displayName numericId')
        .exec(),
      this.momentModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  async adminRemove(momentId: string, reason: string, adminId?: string): Promise<MomentDocument> {
    const m = await this.getByIdOrThrow(momentId);
    m.status = MomentStatus.REMOVED;
    m.removedReason = reason;
    m.removedAt = new Date();
    if (adminId && Types.ObjectId.isValid(adminId)) {
      m.removedBy = new Types.ObjectId(adminId);
    }
    await m.save();
    return m;
  }

  async adminRestore(momentId: string): Promise<MomentDocument> {
    const m = await this.getByIdOrThrow(momentId);
    m.status = MomentStatus.ACTIVE;
    m.removedReason = '';
    m.removedAt = null;
    m.removedBy = null;
    await m.save();
    return m;
  }

  // ============== Comments ==============

  /** Paginated comment thread for a moment. Returns active comments only,
   * newest-first (matches the sort the mobile composer assumes). */
  async listComments(momentId: string, params: { page?: number; limit?: number }) {
    if (!Types.ObjectId.isValid(momentId)) {
      throw new BadRequestException({
        code: 'INVALID_MOMENT_ID',
        message: 'Invalid moment id',
      });
    }
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 30));
    const skip = (page - 1) * limit;

    const filter: FilterQuery<MomentCommentDocument> = {
      momentId: new Types.ObjectId(momentId),
      status: CommentStatus.ACTIVE,
    };
    const [items, total] = await Promise.all([
      this.commentModel
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('authorId', 'username displayName avatarUrl numericId level isHost')
        .exec(),
      this.commentModel.countDocuments(filter).exec(),
    ]);
    return { items, page, limit, total };
  }

  async createComment(params: {
    momentId: string;
    authorId: string;
    text: string;
    parentId?: string;
  }): Promise<MomentCommentDocument> {
    if (
      !Types.ObjectId.isValid(params.momentId) ||
      !Types.ObjectId.isValid(params.authorId)
    ) {
      throw new BadRequestException({ code: 'INVALID_ID', message: 'Invalid id' });
    }
    const text = params.text.trim();
    if (text.length === 0) {
      throw new BadRequestException({
        code: 'EMPTY_COMMENT',
        message: 'Comment cannot be empty',
      });
    }
    const moment = await this.getByIdOrThrow(params.momentId);
    if (moment.status !== MomentStatus.ACTIVE) {
      throw new BadRequestException({
        code: 'MOMENT_INACTIVE',
        message: 'Cannot comment on an inactive moment',
      });
    }

    let parentId: Types.ObjectId | null = null;
    if (params.parentId) {
      if (!Types.ObjectId.isValid(params.parentId)) {
        throw new BadRequestException({
          code: 'INVALID_PARENT_ID',
          message: 'Invalid reply target',
        });
      }
      const parent = await this.commentModel.findById(params.parentId).exec();
      if (!parent || parent.momentId.toString() !== params.momentId) {
        throw new NotFoundException('Reply target not found');
      }
      parentId = parent._id;
    }

    const created = await this.commentModel.create({
      momentId: new Types.ObjectId(params.momentId),
      authorId: new Types.ObjectId(params.authorId),
      text,
      parentId,
      status: CommentStatus.ACTIVE,
    });

    // Bump the denormalized counter on the parent moment so feed cards
    // show the right number without a second query.
    await this.momentModel
      .updateOne({ _id: moment._id }, { $inc: { commentCount: 1 } })
      .exec();

    // Re-fetch with author populated so the mobile sheet can render the
    // new comment immediately without a roundtrip to refresh the list.
    return (await this.commentModel
      .findById(created._id)
      .populate('authorId', 'username displayName avatarUrl numericId level isHost')
      .exec())!;
  }

  async deleteOwnComment(commentId: string, userId: string): Promise<void> {
    if (!Types.ObjectId.isValid(commentId)) {
      throw new NotFoundException('Comment not found');
    }
    const c = await this.commentModel.findById(commentId).exec();
    if (!c || c.status === CommentStatus.DELETED) {
      throw new NotFoundException('Comment not found');
    }
    if (c.authorId.toString() !== userId) {
      throw new ForbiddenException({
        code: 'NOT_AUTHOR',
        message: 'You can only delete your own comments',
      });
    }
    c.status = CommentStatus.DELETED;
    await c.save();
    await this.momentModel
      .updateOne(
        { _id: c.momentId, commentCount: { $gt: 0 } },
        { $inc: { commentCount: -1 } },
      )
      .exec();
  }

  async adminRemoveComment(
    commentId: string,
    reason: string,
    adminId?: string,
  ): Promise<MomentCommentDocument> {
    const c = await this.commentModel.findById(commentId).exec();
    if (!c) throw new NotFoundException('Comment not found');
    const wasActive = c.status === CommentStatus.ACTIVE;
    c.status = CommentStatus.REMOVED;
    c.removedReason = reason;
    if (adminId && Types.ObjectId.isValid(adminId)) {
      c.removedBy = new Types.ObjectId(adminId);
    }
    await c.save();
    if (wasActive) {
      await this.momentModel
        .updateOne(
          { _id: c.momentId, commentCount: { $gt: 0 } },
          { $inc: { commentCount: -1 } },
        )
        .exec();
    }
    return c;
  }

  // ============== helpers ==============

  async getByIdOrThrow(id: string): Promise<MomentDocument> {
    if (!Types.ObjectId.isValid(id)) {
      throw new NotFoundException('Moment not found');
    }
    const m = await this.momentModel.findById(id).exec();
    if (!m) throw new NotFoundException('Moment not found');
    return m;
  }
}
