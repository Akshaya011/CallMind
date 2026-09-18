import pool from './db.js';
import { seedDemoData } from './seed.js';

export async function initDatabase() {
  try {
    await pool.query('SELECT 1');
    await seedDemoData();
    console.log('Database initialized and demo data seeded.');
  } catch (error) {
    console.error('Database init failed:', error);
    throw error;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  initDatabase();
}
