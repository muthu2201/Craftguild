import { newId } from '../domain/ids.js';
import { err } from '../domain/errors.js';
import type { Clock } from '../domain/clock.js';
import type { ChapterRecord, Database, UnitOfWork, WorkRecord } from '../ports/repository.port.js';

/** Works and chapters. Pricing is denominated in credits; money is derived at redemption. */
export class CatalogService {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
    private readonly creditValuePaise: number,
  ) {}

  async createWork(input: { creatorId: string; title: string; synopsis?: string }): Promise<WorkRecord> {
    const title = input.title.trim();
    if (title.length < 1 || title.length > 200) {
      throw err.validation('catalog.invalid_title', 'title must be between 1 and 200 characters');
    }
    const id = newId('work');
    const slug = await this.uniqueSlug(title);

    return this.db.transaction(async (uow) => {
      const creator = await uow.query<{ kyc_status: string }>('SELECT kyc_status FROM creators WHERE id = $1', [
        input.creatorId,
      ]);
      if (creator.rowCount === 0) throw err.notFound('catalog.creator_missing', 'creator does not exist');

      await uow.query(
        `INSERT INTO works (id, creator_id, title, slug, synopsis, status)
         VALUES ($1, $2, $3, $4, $5, 'draft')`,
        [id, input.creatorId, title, slug, (input.synopsis ?? '').slice(0, 4000)],
      );
      return this.loadWork(uow, id);
    });
  }

  async publishWork(creatorId: string, workId: string): Promise<WorkRecord> {
    return this.db.transaction(async (uow) => {
      const work = await this.loadWork(uow, workId);
      if (work.creatorId !== creatorId) throw err.forbidden('catalog.not_owner', 'this work belongs to another creator');
      await uow.query(`UPDATE works SET status = 'published', updated_at = now() WHERE id = $1`, [workId]);
      return this.loadWork(uow, workId);
    });
  }

  async addChapter(input: {
    creatorId: string;
    workId: string;
    title: string;
    priceCredits: number;
    bodyUri?: string;
    sequence?: number;
  }): Promise<ChapterRecord> {
    if (!Number.isInteger(input.priceCredits) || input.priceCredits < 0 || input.priceCredits > 100_000) {
      throw err.validation('catalog.invalid_price', 'chapter price must be a whole number of credits (0..100000)');
    }

    return this.db.transaction(async (uow) => {
      const work = await this.loadWork(uow, input.workId);
      if (work.creatorId !== input.creatorId) {
        throw err.forbidden('catalog.not_owner', 'this work belongs to another creator');
      }

      const seqRes = await uow.query<{ next: number }>(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM chapters WHERE work_id = $1',
        [input.workId],
      );
      const sequence = input.sequence ?? seqRes.rows[0]?.next ?? 1;
      const id = newId('chapter');

      await uow.query(
        `INSERT INTO chapters (id, work_id, creator_id, sequence, title, body_uri, price_credits, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'draft')`,
        [id, input.workId, input.creatorId, sequence, input.title.trim().slice(0, 200), input.bodyUri ?? '', input.priceCredits],
      );
      return this.loadChapter(uow, id);
    });
  }

  async publishChapter(creatorId: string, chapterId: string): Promise<ChapterRecord> {
    return this.db.transaction(async (uow) => {
      const chapter = await this.loadChapter(uow, chapterId);
      if (chapter.creatorId !== creatorId) {
        throw err.forbidden('catalog.not_owner', 'this chapter belongs to another creator');
      }
      const creator = await uow.query<{ kyc_status: string }>('SELECT kyc_status FROM creators WHERE id = $1', [
        creatorId,
      ]);
      if (chapter.priceCredits > 0 && creator.rows[0]?.kyc_status !== 'active') {
        throw err.precondition(
          'catalog.kyc_incomplete',
          'complete payout onboarding before publishing paid chapters',
        );
      }
      await uow.query(
        `UPDATE chapters SET status = 'published', published_at = COALESCE(published_at, $2) WHERE id = $1`,
        [chapterId, this.clock.now()],
      );
      await uow.query(`UPDATE works SET status = 'published', updated_at = now() WHERE id = $1 AND status = 'draft'`, [
        chapter.workId,
      ]);
      return this.loadChapter(uow, chapterId);
    });
  }

  async loadWork(uow: UnitOfWork, workId: string): Promise<WorkRecord> {
    const res = await uow.query<WorkRow>('SELECT * FROM works WHERE id = $1', [workId]);
    if (res.rowCount === 0) throw err.notFound('catalog.work_not_found', 'work does not exist', { workId });
    const r = res.rows[0]!;
    return {
      id: r.id,
      creatorId: r.creator_id,
      title: r.title,
      slug: r.slug,
      synopsis: r.synopsis,
      status: r.status,
      createdAt: r.created_at,
    };
  }

  async loadChapter(uow: UnitOfWork, chapterId: string): Promise<ChapterRecord> {
    const res = await uow.query<ChapterRow>('SELECT * FROM chapters WHERE id = $1', [chapterId]);
    if (res.rowCount === 0) throw err.notFound('catalog.chapter_not_found', 'chapter does not exist', { chapterId });
    return mapChapter(res.rows[0]!);
  }

  async getChapter(chapterId: string): Promise<ChapterRecord> {
    return this.db.transaction((uow) => this.loadChapter(uow, chapterId), { readOnly: true });
  }

  async listPublishedChapters(workId: string): Promise<ChapterRecord[]> {
    return this.db.transaction(
      async (uow) => {
        const res = await uow.query<ChapterRow>(
          `SELECT * FROM chapters WHERE work_id = $1 AND status = 'published' ORDER BY sequence`,
          [workId],
        );
        return res.rows.map(mapChapter);
      },
      { readOnly: true },
    );
  }

  chapterPricePaise(chapter: ChapterRecord): number {
    return chapter.priceCredits * this.creditValuePaise;
  }

  private async uniqueSlug(title: string): Promise<string> {
    const base =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'work';
    return `${base}-${newId('work').slice(-8)}`;
  }
}

interface WorkRow {
  id: string;
  creator_id: string;
  title: string;
  slug: string;
  synopsis: string;
  status: WorkRecord['status'];
  created_at: Date;
}

interface ChapterRow {
  id: string;
  work_id: string;
  creator_id: string;
  sequence: number;
  title: string;
  price_credits: number;
  status: ChapterRecord['status'];
  published_at: Date | null;
}

function mapChapter(r: ChapterRow): ChapterRecord {
  return {
    id: r.id,
    workId: r.work_id,
    creatorId: r.creator_id,
    sequence: r.sequence,
    title: r.title,
    priceCredits: r.price_credits,
    status: r.status,
    publishedAt: r.published_at,
  };
}
