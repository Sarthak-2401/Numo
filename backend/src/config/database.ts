import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres';
const endpoint = new URL(connectionString);
const localDatabase = ['localhost', '127.0.0.1', '[::1]', 'postgres'].includes(endpoint.hostname);
const pool = new Pool({
  connectionString,
  ssl: localDatabase ? false : { rejectUnauthorized: false },
});

pool.on('connect', () => {
  console.log('📦 Connected to PostgreSQL');
});

pool.on('error', (err) => {
  console.error('❌ PostgreSQL connection error:', err);
});

export default pool;
