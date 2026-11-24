import { Router } from 'express';
import type { Request, Response } from 'express';
import { getSyncState, syncCatalog } from '../services/catalog-sync.js';

export const catalogRouter = Router();

/** POST /api/catalog/sync — pull the latest catalog immediately. */
catalogRouter.post('/sync', async (_req: Request, res: Response) => {
  const sync = await syncCatalog(true);
  res.json({ catalog: getSyncState(), sync });
});
