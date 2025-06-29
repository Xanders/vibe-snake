import fs from 'fs';
import path from 'path';
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

export interface User {
    id: string;
    token: string;
    name: string;
    emoji: string | null;
    telegram_id: string | null;
    nickname: string | null;
    game_credits: number;
    cooldown_until: number;
}

const DB_PATH = path.join(__dirname, '../db/snake.db');
let db: Database<sqlite3.Database, sqlite3.Statement>;

export async function initDB(): Promise<void> {
    const exists = fs.existsSync(DB_PATH);
    db = await open({ filename: DB_PATH, driver: sqlite3.Database });
    if (!exists) {
        await createSchema();
    } else {
        await verifySchema();
    }
}

async function createSchema(): Promise<void> {
    await db.exec(`CREATE TABLE IF NOT EXISTS users (
        token TEXT PRIMARY KEY,
        id TEXT,
        name TEXT,
        emoji TEXT,
        telegram_id TEXT,
        nickname TEXT,
        game_credits INTEGER DEFAULT 0,
        cooldown_until INTEGER DEFAULT 0
    )`);
    await db.exec(`CREATE TABLE IF NOT EXISTS mp_leaderboard (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ids TEXT,
        names TEXT,
        score INTEGER,
        date INTEGER
    )`);
}

async function verifySchema(): Promise<void> {
    try {
        await db.get(`SELECT token, id, name, emoji, telegram_id, nickname, game_credits, cooldown_until FROM users LIMIT 1`);
    } catch {
        try {
            await db.exec(`ALTER TABLE users ADD COLUMN id TEXT`);
        } catch {}
        try {
            await db.exec(`ALTER TABLE users ADD COLUMN emoji TEXT`);
        } catch {}
        try {
            await db.exec(`ALTER TABLE users ADD COLUMN telegram_id TEXT`);
        } catch {}
        try {
            await db.exec(`ALTER TABLE users ADD COLUMN nickname TEXT`);
        } catch {}
        try {
            await db.exec(`ALTER TABLE users ADD COLUMN game_credits INTEGER DEFAULT 0`);
        } catch {}
        try {
            await db.exec(`ALTER TABLE users ADD COLUMN cooldown_until INTEGER DEFAULT 0`);
        } catch {}
        // if table still invalid create from scratch
        try {
            await db.get(`SELECT token, id, name, emoji, telegram_id, nickname, game_credits, cooldown_until FROM users LIMIT 1`);
        } catch {
            await createSchema();
        }
    }

    // ensure mp_leaderboard table exists
    try {
        await db.get(`SELECT ids, names, score, date FROM mp_leaderboard LIMIT 1`);
    } catch {
        await db.exec(`CREATE TABLE IF NOT EXISTS mp_leaderboard (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ids TEXT,
            names TEXT,
            score INTEGER,
            date INTEGER
        )`);
    }
}

export async function createUser(
    id: string,
    name: string,
    token: string,
    emoji: string,
    telegram_id?: string | null,
    nickname?: string | null,
): Promise<void> {
    await db.run(
        `INSERT INTO users (token, id, name, emoji, telegram_id, nickname, game_credits, cooldown_until) VALUES (?, ?, ?, ?, ?, ?, 0, 0)`,
        token,
        id,
        name,
        emoji,
        telegram_id ?? null,
        nickname ?? null,
    );
}

export async function getUserByToken(token: string): Promise<User | undefined> {
    return db.get<User>(
        `SELECT token, id, name, emoji, telegram_id, nickname, game_credits, cooldown_until FROM users WHERE token = ?`,
        token,
    );
}

export async function getUserByTelegramId(tgId: string): Promise<User | undefined> {
    return db.get<User>(
        `SELECT token, id, name, emoji, telegram_id, nickname, game_credits, cooldown_until FROM users WHERE telegram_id = ?`,
        tgId,
    );
}

export async function updateUserEmoji(token: string, emoji: string): Promise<void> {
    await db.run(`UPDATE users SET emoji = ? WHERE token = ?`, emoji, token);
}

export async function updateUserId(token: string, id: string): Promise<void> {
    await db.run(`UPDATE users SET id = ? WHERE token = ?`, id, token);
}

export async function setUserGameCredits(token: string, credits: number): Promise<void> {
    await db.run(`UPDATE users SET game_credits = ? WHERE token = ?`, credits, token);
}

export async function setUserCooldown(token: string, until: number): Promise<void> {
    await db.run(`UPDATE users SET cooldown_until = ? WHERE token = ?`, until, token);
}

export async function getLeastUsedEmoji(emojis: string[]): Promise<string> {
    const rows = await db.all<{ emoji: string; count: number }[]>(
        `SELECT emoji, COUNT(*) as count FROM users GROUP BY emoji`
    );
    const counts = new Map<string, number>();
    for (const e of emojis) counts.set(e, 0);
    for (const r of rows) counts.set(r.emoji, r.count);
    let selected = emojis[0];
    let min = Infinity;
    for (const e of emojis) {
        const c = counts.get(e) ?? 0;
        if (c < min) {
            min = c;
            selected = e;
        }
    }
    return selected;
}

export interface MultiplayerEntry {
    ids: string;
    names: string;
    score: number;
    date: number;
}

export async function addMultiplayerScore(ids: string, names: string, score: number): Promise<void> {
    const date = Date.now();
    await db.run(
        `INSERT INTO mp_leaderboard (ids, names, score, date) VALUES (?, ?, ?, ?)`,
        ids,
        names,
        score,
        date,
    );
}

export async function getMultiplayerLeaderboard(limit = 20): Promise<MultiplayerEntry[]> {
    return db.all<MultiplayerEntry[]>(
        `SELECT ids, names, score, date FROM mp_leaderboard ORDER BY score ASC, id ASC LIMIT ?`,
        limit,
    );
}
