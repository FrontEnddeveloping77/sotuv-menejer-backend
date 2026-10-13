require('dotenv').config();

const { Pool } = require('pg');
const migrateAccountContract = require('../migrations/account-contract');

const databaseUrl = process.env.DATABASE_URL;
const pool = new Pool(
    databaseUrl
        ? {
            connectionString: databaseUrl,
            ssl:
                process.env.DATABASE_SSL === 'false'
                    ? false
                    : { rejectUnauthorized: false }
        }
        : {
            host: process.env.DB_HOST || 'localhost',
            port: Number(process.env.DB_PORT || 5432),
            database: process.env.DB_NAME || 'shop_manager',
            user: process.env.DB_USER || 'postgres',
            password: process.env.DB_PASSWORD || undefined,
            ssl:
                process.env.DB_SSL === 'true'
                    ? { rejectUnauthorized: false }
                    : false
        }
);

migrateAccountContract(pool)
    .then(() => console.log('Account contract migration muvaffaqiyatli bajarildi.'))
    .catch((err) => {
        console.error('Account contract migration xatosi:', err);
        process.exitCode = 1;
    })
    .finally(() => pool.end());
