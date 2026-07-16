import 'dotenv/config';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { schema } from '../schema';

const url = process.env.DATABASE_URL ?? 'postgres://sharifur@localhost:5432/geniusdebug_dev';

/** Shared postgres.js pool + typed drizzle client ({ schema }). */
export const sql = postgres(url, { max: 10 });
export const db = drizzle(sql, { schema });
export type Db = typeof db;
