const migrateAccountContract = async (pool) => {
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        await client.query(`
            ALTER TABLE public.users
                ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS pricing_model TEXT,
                ADD COLUMN IF NOT EXISTS product_count INTEGER NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS payment_method TEXT,
                ADD COLUMN IF NOT EXISTS last_reminder_at TIMESTAMPTZ,
                ADD COLUMN IF NOT EXISTS deletion_warning_count INTEGER NOT NULL DEFAULT 0,
                ADD COLUMN IF NOT EXISTS last_deletion_warning_at TIMESTAMPTZ
        `);

        for (const columnName of [
            'expires_at',
            'last_reminder_at',
            'last_deletion_warning_at'
        ]) {
            const columnType = await client.query(
                `
                SELECT data_type
                FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND table_name = 'users'
                  AND column_name = $1
                `,
                [columnName]
            );
            if (columnType.rows[0]?.data_type === 'timestamp without time zone') {
                await client.query(`
                    ALTER TABLE public.users
                    ALTER COLUMN "${columnName}" TYPE TIMESTAMPTZ
                    USING "${columnName}" AT TIME ZONE 'UTC'
                `);
            }
        }

        await client.query(`
            ALTER TABLE public.notifications
                ADD COLUMN IF NOT EXISTS photo_url TEXT,
                ADD COLUMN IF NOT EXISTS product_id INTEGER,
                ADD COLUMN IF NOT EXISTS product_category TEXT,
                ADD COLUMN IF NOT EXISTS delivered_chat_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
                ADD COLUMN IF NOT EXISTS event_id TEXT
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_event_id_unique
            ON public.notifications(event_id)
            WHERE event_id IS NOT NULL
        `);

        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('Account contract migration rollback xatosi:', rollbackError);
        }
        throw err;
    } finally {
        client.release();
    }
};

module.exports = migrateAccountContract;
