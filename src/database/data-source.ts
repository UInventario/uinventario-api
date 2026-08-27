import 'dotenv/config';
import { DataSource } from 'typeorm';
import { join } from 'node:path';

export default new DataSource({
  type: 'mysql',
  url: process.env.DATABASE_URL,
  charset: 'utf8mb4',
  entities: [join(__dirname, '..', '**', '*.entity.{js,ts}')],
  migrations: [join(__dirname, 'migrations', '*.{js,ts}')],
  synchronize: false,
});
