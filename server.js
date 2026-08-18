// backend/server.js
// To'liq ishlaydigan versiya — mavjud funksiyalar saqlangan + yangi:
// - POST /api/dashboard/sell-credit  (nasiyaga sotish)
// - GET  /api/debts/recent-payments  (oxirgi to'lovlar)
// - POST /api/debts/undo-or-edit     (to'lovni bekor qilish / tahrirlash)
// - POST /api/qr/:token/sell-credit  (QR orqali nasiyaga sotish)
// - GET  /api/products/deleted       (o'chirilgan tovarlar)
// - POST /api/products/restore       (omborga qaytarish)

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jwt-simple');
const { randomUUID } = require('crypto');

const app = express();

// ====================================================
// MIDDLEWARE
// ====================================================

app.use(cors());
// Rasm (base64) uchun body limit oshirilgan
app.use(express.json({ limit: '3mb' }));
app.use(express.urlencoded({ extended: true, limit: '3mb' }));

// ====================================================
// JADVALLARNI TAYYORLASH — "GATE" MIDDLEWARE
// ====================================================

let tablesReadyPromise = null;

const ensureTablesOnce = () => {
    if (!tablesReadyPromise) {
        tablesReadyPromise = ensureTables().catch((err) => {
            console.error(
                '❌ ensureTables() umumiy xatosi:',
                err
            );
            tablesReadyPromise = null;
        });
    }
    return tablesReadyPromise;
};

app.use(async (req, res, next) => {
    try {
        await ensureTablesOnce();
    } catch (err) {
        console.error('Gate middleware xatosi:', err);
    }
    next();
});

// ====================================================
// POSTGRESQL / SUPABASE
// ====================================================

const databaseUrl = process.env.DATABASE_URL;

const poolConfig = databaseUrl
    ? {
        connectionString: databaseUrl,
        ssl:
            process.env.DATABASE_SSL === 'false'
                ? false
                : {
                    rejectUnauthorized: false
                }
    }
    : {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 5432),
        database: process.env.DB_NAME || 'shop_manager',
        user: process.env.DB_USER || 'postgres',
        password: process.env.DB_PASSWORD || undefined,
        ssl:
            process.env.DB_SSL === 'true'
                ? {
                    rejectUnauthorized: false
                }
                : false
    };

const pool = new Pool(poolConfig);

pool.on('error', (err) => {
    console.error('PostgreSQL pool xatosi:', err);
});

const JWT_SECRET =
    process.env.JWT_SECRET || 'super_secret_jwt_key_123';

// ====================================================
// TAHRIRLASH / VOZVRAT UCHUN MUDDATLAR
// ====================================================

const PRODUCT_EDIT_WINDOW_DAYS = 7;
const SALE_RETURN_WINDOW_DAYS = 7;
const EXPENSE_EDIT_WINDOW_DAYS = 30;
const DEBT_PAYMENT_UNDO_WINDOW_DAYS = 30;
const DELETED_RESTORE_WINDOW_DAYS = 7;


const daysSince = (dateValue) => {
    if (!dateValue) return Infinity;
    const then = new Date(dateValue).getTime();
    if (Number.isNaN(then)) return Infinity;
    return (Date.now() - then) / (1000 * 60 * 60 * 24);
};

// ====================================================
// YORDAMCHI FUNKSIYALAR
// ====================================================

const formatSum = (value) => {
    if (value === undefined || value === null) {
        return '0';
    }
    return Number(value).toLocaleString('uz-UZ');
};

const telegramEscape = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

// ====================================================
// BUGUNGI HISOBOT
// ====================================================

const getTodayReport = async (clientOrPool, userId) => {
    const salesResult = await clientOrPool.query(
        `
        SELECT
            COALESCE(SUM(quantity * selling_price), 0) AS revenue,
            COALESCE(SUM(profit), 0) AS profit,
            COALESCE(SUM(quantity), 0) AS sold
        FROM public.sales
        WHERE user_id = $1
          AND sold_at::date = CURRENT_DATE
          AND returned = false
        `,
        [userId]
    );

    const expenseResult = await clientOrPool.query(
        `
        SELECT COALESCE(SUM(amount), 0) AS expense
        FROM public.expenses
        WHERE user_id = $1
          AND created_at::date = CURRENT_DATE
        `,
        [userId]
    );

    const stockResult = await clientOrPool.query(
        `
        SELECT
            COUNT(DISTINCT local_id) AS total_products,
            COALESCE(SUM(quantity), 0) AS total_stock
        FROM public.products
        WHERE user_id = $1
        `,
        [userId]
    );

    const revenue = Number(salesResult.rows[0].revenue || 0);
    const profit = Number(salesResult.rows[0].profit || 0);
    const sold = Number(salesResult.rows[0].sold || 0);
    const expense = Number(expenseResult.rows[0].expense || 0);
    const netProfit = profit - expense;
    const totalProducts = Number(stockResult.rows[0].total_products || 0);
    const totalStock = Number(stockResult.rows[0].total_stock || 0);

    return (
        `\n\n` +
        `📊 <b>BUGUNGI HISOBOT</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `💰 <b>Bugungi tushum:</b> ${formatSum(revenue)} so'm\n` +
        `📈 <b>Bugungi foyda:</b> ${formatSum(profit)} so'm\n` +
        `💸 <b>Bugungi rasxod:</b> ${formatSum(expense)} so'm\n` +
        `${netProfit >= 0 ? '🟢' : '🔴'} <b>Bugungi umumiy sof foyda:</b> ${formatSum(Math.abs(netProfit))} so'm` +
        (netProfit < 0 ? ` (ziyon)` : '') +
        `\n━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 <b>OMBOR HOLATI</b>\n` +
        `🗂 <b>Jami tovar turi:</b> ${totalProducts} xil\n` +
        `📊 <b>Jami qoldiq:</b> ${totalStock} dona` +
        `\n━━━━━━━━━━━━━━━━━━━━`
    );
};

// ====================================================
// OYLIK HISOBOT (Telegram uchun)
// ====================================================
const getMonthReport = async (clientOrPool, userId) => {
    const salesResult = await clientOrPool.query(
        `
        SELECT
            COALESCE(SUM(quantity * selling_price), 0) AS revenue,
            COALESCE(SUM(profit), 0) AS profit,
            COALESCE(SUM(quantity), 0) AS sold
        FROM public.sales
        WHERE user_id = $1
          AND date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)
          AND returned = false
        `,
        [userId]
    );

    const expenseResult = await clientOrPool.query(
        `
        SELECT COALESCE(SUM(amount), 0) AS expense
        FROM public.expenses
        WHERE user_id = $1
          AND date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)
        `,
        [userId]
    );

    const debtResult = await clientOrPool.query(
        `
        SELECT COALESCE(SUM(debt), 0) AS total_debt
        FROM (
            SELECT
                GREATEST(
                    SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                    0
                ) AS debt
            FROM public.products
            WHERE user_id = $1
              AND payment_type = 'credit'
            GROUP BY local_id
        ) t
        `,
        [userId]
    );

    const stockResult = await clientOrPool.query(
        `
        SELECT
            COUNT(DISTINCT local_id) AS total_products,
            COALESCE(SUM(quantity), 0) AS total_stock
        FROM public.products
        WHERE user_id = $1
        `,
        [userId]
    );

    const revenue = Number(salesResult.rows[0].revenue || 0);
    const profit = Number(salesResult.rows[0].profit || 0);
    const sold = Number(salesResult.rows[0].sold || 0);
    const expense = Number(expenseResult.rows[0].expense || 0);
    const netProfit = profit - expense;
    const totalDebt = Number(debtResult.rows[0].total_debt || 0);
    const totalProducts = Number(stockResult.rows[0].total_products || 0);
    const totalStock = Number(stockResult.rows[0].total_stock || 0);

    const now = new Date();
    const monthName = now.toLocaleString('uz-UZ', { month: 'long', year: 'numeric' });

    return (
        `📅 <b>OYLIK HISOBOT</b>\n` +
        `🗓 <b>Oy:</b> ${telegramEscape(monthName)}\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `🛒 <b>Sotilgan:</b> ${sold} dona\n` +
        `💰 <b>Tushum:</b> ${formatSum(revenue)} so'm\n` +
        `📈 <b>Foyda:</b> ${formatSum(profit)} so'm\n` +
        `💸 <b>Rasxod:</b> ${formatSum(expense)} so'm\n` +
        `${netProfit >= 0 ? '🟢' : '🔴'} <b>Sof foyda:</b> ${formatSum(Math.abs(netProfit))} so'm` +
        (netProfit < 0 ? ` (ziyon)` : '') +
        `\n💳 <b>Jami qarz:</b> ${formatSum(totalDebt)} so'm\n` +
        `━━━━━━━━━━━━━━━━━━━━\n` +
        `📦 <b>OMBOR HOLATI</b>\n` +
        `🗂 <b>Jami tovar turi:</b> ${totalProducts} xil\n` +
        `📊 <b>Jami qoldiq:</b> ${totalStock} dona\n` +
        `━━━━━━━━━━━━━━━━━━━━`
    );
};

// ====================================================
// BARCHA FOYDALANUVCHILARGA HISOBOT YUBORISH
// ====================================================
const sendReportToAllUsers = async (type = 'daily') => {
    try {
        const usersResult = await pool.query(
            `SELECT id, site_login, full_name FROM public.users WHERE site_login IS NOT NULL`
        );

        for (const user of usersResult.rows) {
            try {
                let message = '';

                if (type === 'daily') {
                    message =
                        `🌙 <b>KUNLIK YAKUNIY HISOBOT</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 <b>Do'kon:</b> ${telegramEscape(user.full_name || user.site_login)}\n`;
                    message += await getTodayReport(pool, user.id);
                } else {
                    message =
                        `📆 <b>OYLIK YAKUNIY HISOBOT</b>\n` +
                        `━━━━━━━━━━━━━━━━━━━━\n` +
                        `👤 <b>Do'kon:</b> ${telegramEscape(user.full_name || user.site_login)}\n\n`;
                    message += await getMonthReport(pool, user.id);
                }

                await queueTelegramNotification(pool, user.site_login, message);
                console.log(`[REPORT] ${type} hisobot yuborildi: ${user.site_login}`);
            } catch (err) {
                console.error(`[REPORT] ${user.site_login} ga yuborishda xato:`, err.message);
            }
        }
    } catch (err) {
        console.error('[REPORT] Umumiy xato:', err);
    }
};

// ====================================================
// TELEGRAM NOTIFICATION QUEUE + TO'G'RIDAN-TO'G'RI YUBORISH
// ====================================================

const TELEGRAM_BOT_TOKEN =
    process.env.TELEGRAM_BOT_TOKEN ||
    process.env.BOT_TOKEN ||
    process.env.TG_BOT_TOKEN ||
    '';

// Bitta guruh uchun (ixtiyoriy) — users.linked_group_chat_id bo'lmasa ishlatiladi
const TELEGRAM_CHAT_ID =
    process.env.TELEGRAM_CHAT_ID ||
    process.env.TG_CHAT_ID ||
    process.env.CHAT_ID ||
    '';

const telegramApi = async (method, formData) => {
    if (!TELEGRAM_BOT_TOKEN) {
        throw new Error('TELEGRAM_BOT_TOKEN / BOT_TOKEN env topilmadi');
    }
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
    const res = await fetch(url, { method: 'POST', body: formData });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) {
        throw new Error(data.description || `Telegram API xato: ${method}`);
    }
    return data;
};

/** data:image/...;base64,XXXX → Buffer */
const dataUrlToBuffer = (dataUrl) => {
    if (!dataUrl || typeof dataUrl !== 'string') return null;
    if (!dataUrl.startsWith('data:image')) return null;
    const parts = dataUrl.split(',');
    if (parts.length < 2) return null;
    return Buffer.from(parts[1], 'base64');
};

const sendTelegramNow = async (chatId, message, photoUrl = null) => {
    if (!chatId) throw new Error('chat_id yo\'q');
    const text = String(message || '');
    const hasPhoto = !!(photoUrl && String(photoUrl).trim());

    if (hasPhoto) {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('parse_mode', 'HTML');

        const buf = dataUrlToBuffer(photoUrl);
        if (buf) {
            // Node 18+ FormData + Blob
            const blob = new Blob([buf], { type: 'image/jpeg' });
            form.append('photo', blob, 'product.jpg');
        } else if (String(photoUrl).startsWith('http')) {
            form.append('photo', String(photoUrl));
        } else {
            // noma'lum format — faqat matn
            const f2 = new FormData();
            f2.append('chat_id', String(chatId));
            f2.append('text', text);
            f2.append('parse_mode', 'HTML');
            await telegramApi('sendMessage', f2);
            return;
        }

        // Caption max 1024
        if (text.length <= 1024) {
            form.append('caption', text);
            await telegramApi('sendPhoto', form);
        } else {
            form.append('caption', text.slice(0, 1024));
            await telegramApi('sendPhoto', form);
            const f2 = new FormData();
            f2.append('chat_id', String(chatId));
            f2.append('text', text.slice(1024));
            f2.append('parse_mode', 'HTML');
            await telegramApi('sendMessage', f2);
        }
        return;
    }

    // Rasm yo'q — oddiy matn (4096 limit)
    if (text.length <= 4096) {
        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append('text', text);
        form.append('parse_mode', 'HTML');
        await telegramApi('sendMessage', form);
    } else {
        // bo'lib yuborish
        for (let i = 0; i < text.length; i += 4096) {
            const form = new FormData();
            form.append('chat_id', String(chatId));
            form.append('text', text.slice(i, i + 4096));
            form.append('parse_mode', 'HTML');
            await telegramApi('sendMessage', form);
        }
    }
};

const queueTelegramNotification = async (
    clientOrPool,
    siteLogin,
    message,
    photoUrl = null
) => {
    if (!siteLogin) {
        console.warn('Telegram notification queue: site_login topilmadi.');
        return;
    }

    const hasPhoto = !!(photoUrl && String(photoUrl).trim());

    // 1) Navbatga yozish (backup)
    let inserted = false;
    try {
        await clientOrPool.query(
            `
            INSERT INTO public.notifications
            (
                site_login,
                message,
                is_sent,
                photo_url
            )
            VALUES
            ($1, $2, false, $3)
            `,
            [
                siteLogin,
                message,
                hasPhoto ? photoUrl : null
            ]
        );
        inserted = true;
    } catch (err) {
        console.error('[Telegram queue] INSERT xato:', err.message);
    }

    console.log(
        `[Telegram queue] site=${siteLogin} photo=${hasPhoto ? 'YES (' + Math.round(String(photoUrl).length / 1024) + 'KB)' : 'NO'}`
    );

    // 2) To'g'ridan-to'g'ri Telegramga yuborish (rasm ishlashi uchun)
    if (!TELEGRAM_BOT_TOKEN) {
        console.warn('[Telegram] BOT_TOKEN yo\'q — faqat navbatga yozildi. Env: TELEGRAM_BOT_TOKEN yoki BOT_TOKEN');
        return;
    }

    try {
        let chatId = null;
        try {
            const u = await clientOrPool.query(
                `
                SELECT linked_group_chat_id
                FROM public.users
                WHERE site_login = $1
                LIMIT 1
                `,
                [siteLogin]
            );
            chatId = u.rows[0]?.linked_group_chat_id || null;
        } catch (colErr) {
            // Ustun bo'lmasa — env dan olamiz
            console.warn('[Telegram] linked_group_chat_id o\'qib bo\'lmadi:', colErr.message);
        }

        if (!chatId && TELEGRAM_CHAT_ID) {
            chatId = TELEGRAM_CHAT_ID;
        }

        if (!chatId) {
            console.warn(
                `[Telegram] chat_id topilmadi (site=${siteLogin}). ` +
                `users.linked_group_chat_id yoki TELEGRAM_CHAT_ID env kerak.`
            );
            return;
        }

        await sendTelegramNow(chatId, message, photoUrl);
        console.log(`[Telegram] YUBORILDI chat=${chatId} photo=${hasPhoto}`);

        // Muvaffaqiyatli yuborilsa — is_sent = true
        if (inserted) {
            try {
                await clientOrPool.query(
                    `
                    UPDATE public.notifications
                    SET is_sent = true
                    WHERE id = (
                        SELECT id FROM public.notifications
                        WHERE site_login = $1 AND is_sent = false
                        ORDER BY id DESC
                        LIMIT 1
                    )
                    `,
                    [siteLogin]
                );
            } catch (e) { /* ignore */ }
        }
    } catch (err) {
        console.error('[Telegram] Yuborish xatosi:', err.message);
        // Navbatda qoladi — bot keyin yuborishi mumkin
    }
};

// ====================================================
// JADVALLARNI YARATISH
// ====================================================

const ensureTables = async () => {

    // ------------------------------------------------
    // USERS
    // ------------------------------------------------
    try {
        await pool.query(`
            ALTER TABLE public.users
            ADD COLUMN IF NOT EXISTS linked_group_chat_id BIGINT;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_users_linked_group_chat_id
            ON public.users(linked_group_chat_id);
        `);
    } catch (err) {
        console.error(
            "⚠️ USERS jadvalini yangilashda xatolik (davom etilmoqda):",
            err.message
        );
    }

    // ------------------------------------------------
    // PRODUCTS
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.products (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                local_id INTEGER NOT NULL DEFAULT 1,
                category TEXT,
                name TEXT NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                color TEXT,
                quantity INTEGER NOT NULL DEFAULT 0,
                size TEXT,
                qr_token UUID,
                qr_created_at TIMESTAMP,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS local_id INTEGER NOT NULL DEFAULT 1;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS category TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS color TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 0;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS size TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS qr_token UUID;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS qr_created_at TIMESTAMP;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS payment_type TEXT DEFAULT 'cash';`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS paid_amount NUMERIC DEFAULT 0;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS supplier_phone TEXT;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS selling_price NUMERIC DEFAULT NULL;`);
        await pool.query(`ALTER TABLE public.products ADD COLUMN IF NOT EXISTS image_url TEXT;`);

        await pool.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS
            idx_products_qr_token
            ON public.products(qr_token)
            WHERE qr_token IS NOT NULL;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_products_user_local
            ON public.products(user_id, local_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_products_user_id
            ON public.products(user_id);
        `);
    } catch (err) {
        console.error(
            "⚠️ PRODUCTS jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // ESKI TOVARLARGA QR TOKEN
    // ------------------------------------------------
    try {
        const qrRows = await pool.query(`
            SELECT id
            FROM public.products
            WHERE qr_token IS NULL
        `);

        for (const row of qrRows.rows) {
            await pool.query(
                `
                UPDATE public.products
                SET
                    qr_token = $1,
                    qr_created_at = NOW()
                WHERE id = $2
                  AND qr_token IS NULL
                `,
                [
                    randomUUID(),
                    row.id
                ]
            );
        }
    } catch (err) {
        console.error(
            "⚠️ Eski tovarlarga QR token biriktirishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // SALES
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.sales (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                product_id INTEGER NOT NULL,
                title TEXT,
                quantity INTEGER NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                selling_price NUMERIC NOT NULL DEFAULT 0,
                profit NUMERIC NOT NULL DEFAULT 0,
                sold_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS local_id INTEGER;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS category TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS color TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS size TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS returned BOOLEAN NOT NULL DEFAULT false;`);
        // Yangi: nasiya sotuv uchun
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_name TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS customer_phone TEXT;`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS is_credit BOOLEAN NOT NULL DEFAULT false;`);
        await pool.query(`
    ALTER TABLE public.sales
    ADD COLUMN IF NOT EXISTS image_url TEXT;
`);
        await pool.query(`ALTER TABLE public.sales ADD COLUMN IF NOT EXISTS paid_now NUMERIC DEFAULT 0;`);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_sales_user_id
            ON public.sales(user_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_sales_sold_at
            ON public.sales(sold_at);
        `);
    } catch (err) {
        console.error(
            "⚠️ SALES jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // EXPENSES
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.expenses (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                amount NUMERIC NOT NULL DEFAULT 0,
                expense_type TEXT NOT NULL DEFAULT 'daily',
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_expenses_user_id
            ON public.expenses(user_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_expenses_created_at
            ON public.expenses(created_at);
        `);
    } catch (err) {
        console.error(
            "⚠️ EXPENSES jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // NOTIFICATIONS
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.notifications (
                id SERIAL PRIMARY KEY,
                site_login TEXT NOT NULL,
                message TEXT NOT NULL,
                is_sent BOOLEAN NOT NULL DEFAULT false,
                created_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);

        await pool.query(`
            ALTER TABLE public.notifications
            ADD COLUMN IF NOT EXISTS photo_url TEXT;
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            idx_notifications_unsent
            ON public.notifications(is_sent, created_at);
        `);
    } catch (err) {
        console.error(
            "⚠️ NOTIFICATIONS jadvalini yaratishda xatolik:",
            err.message
        );
    }

    // ------------------------------------------------
    // DELETED_PRODUCTS (o'chirilgan tovarlar arxivi — 7 kun ichida qaytarish)
    // ------------------------------------------------
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS public.deleted_products (
                id SERIAL PRIMARY KEY,
                original_id INTEGER,
                user_id INTEGER NOT NULL,
                local_id INTEGER,
                category TEXT,
                name TEXT NOT NULL,
                cost_price NUMERIC NOT NULL DEFAULT 0,
                color TEXT,
                size TEXT,
                quantity INTEGER NOT NULL DEFAULT 0,
                payment_type TEXT DEFAULT 'cash',
                supplier TEXT,
                paid_amount NUMERIC DEFAULT 0,
                supplier_phone TEXT,
                selling_price NUMERIC,
                qr_token UUID,
                image_url TEXT,
                deleted_at TIMESTAMP NOT NULL DEFAULT NOW()
            );
        `);
        await pool.query(`
            ALTER TABLE public.deleted_products
            ADD COLUMN IF NOT EXISTS image_url TEXT;
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_deleted_products_user_id
            ON public.deleted_products(user_id);
        `);
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_deleted_products_deleted_at
            ON public.deleted_products(deleted_at);
        `);
    } catch (err) {
        console.error(
            "⚠️ DELETED_PRODUCTS jadvalini yaratishda xatolik:",
            err.message
        );
    }

    console.log(
        '✅ Jadvallar tekshirildi/tayyorlandi (products, sales, expenses, notifications, deleted_products).'
    );
};

// ====================================================
// HEALTH
// ====================================================

app.get('/', (req, res) => {
    res.send(
        'Backend Server muvaffaqiyatli ishlayapti!'
    );
});

app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({
            success: true,
            message:
                'Backend Server muvaffaqiyatli ishlayapti!'
        });
    } catch (err) {
        console.error(
            'Health check xatosi:',
            err
        );
        res.status(500).json({
            success: false,
            message:
                'Database bilan ulanishda xatolik!'
        });
    }
});

// ====================================================
// LOGIN
// ====================================================

app.post('/api/login', async (req, res) => {
    const {
        login,
        password
    } = req.body || {};

    if (!login || !password) {
        return res.status(400).json({
            message:
                'Login va parol kiritilishi shart!'
        });
    }

    try {
        const cleanLogin = String(login).trim();
        const cleanPassword = String(password).trim();

        const result = await pool.query(
            `
            SELECT *
            FROM public.users
            WHERE site_login = $1
            LIMIT 1
            `,
            [cleanLogin]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({
                message:
                    "Login yoki parol noto'g'ri!"
            });
        }

        const user = result.rows[0];

        if (!user.is_paid) {
            return res.status(403).json({
                message:
                    "To'lov qilganingizdan so'ng saytdan foydalana olasiz. Obunangiz faol emas!"
            });
        }

        if (
            user.expires_at &&
            new Date(user.expires_at) < new Date()
        ) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan! Iltimos, obunani yangilang."
            });
        }

        const dbPassword =
            user.site_password_hash ||
            user.site_password ||
            user.password;

        let isPasswordValid = false;

        if (dbPassword) {
            const passwordString = String(dbPassword);

            if (
                passwordString.startsWith('$2a$') ||
                passwordString.startsWith('$2b$') ||
                passwordString.startsWith('$2y$')
            ) {
                try {
                    isPasswordValid = await bcrypt.compare(
                        cleanPassword,
                        passwordString
                    );
                } catch (passwordError) {
                    console.error(
                        'Bcrypt tekshirish xatosi:',
                        passwordError
                    );
                    isPasswordValid = false;
                }
            } else {
                isPasswordValid =
                    cleanPassword ===
                    passwordString.trim();
            }
        }

        if (!isPasswordValid) {
            return res.status(400).json({
                message:
                    "Login yoki parol noto'g'ri!"
            });
        }

        const payload = {
            userId: user.id,
            telegramId: user.telegram_id,
            login: user.site_login,
            exp:
                Math.floor(Date.now() / 1000) +
                7 * 24 * 60 * 60
        };

        const token = jwt.encode(
            payload,
            JWT_SECRET
        );

        return res.json({
            message:
                'Tizimga muvaffaqiyatli kirildi',
            token,
            user: {
                id: user.id,
                telegram_id: user.telegram_id,
                login: user.site_login
            }
        });
    } catch (err) {
        console.error(
            'Login xatosi:',
            err
        );
        return res.status(500).json({
            message:
                'Serverda xatolik yuz berdi!'
        });
    }
});

// ====================================================
// AUTHENTICATION
// ====================================================

const authenticateToken = async (
    req,
    res,
    next
) => {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
        return res.status(401).json({
            message:
                "Avtorizatsiyadan o'tilmagan!"
        });
    }

    const parts = authHeader.split(' ');

    if (
        parts.length !== 2 ||
        parts[0].toLowerCase() !== 'bearer'
    ) {
        return res.status(401).json({
            message:
                'Authorization token formati noto\'g\'ri!'
        });
    }

    const token = parts[1];

    if (!token) {
        return res.status(401).json({
            message:
                "Avtorizatsiyadan o'tilmagan!"
        });
    }

    try {
        const decoded = jwt.decode(
            token,
            JWT_SECRET
        );

        if (
            !decoded ||
            !decoded.userId
        ) {
            return res.status(403).json({
                message:
                    "Yaroqsiz token!"
            });
        }

        if (
            decoded.exp &&
            decoded.exp <
            Math.floor(Date.now() / 1000)
        ) {
            return res.status(403).json({
                message:
                    "Token muddati o'tgan!"
            });
        }

        const result = await pool.query(
            `
            SELECT
                id,
                is_paid,
                expires_at
            FROM public.users
            WHERE id = $1
            LIMIT 1
            `,
            [decoded.userId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({
                message:
                    'Foydalanuvchi topilmadi!'
            });
        }

        const user = result.rows[0];

        if (!user.is_paid) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan!"
            });
        }

        if (
            user.expires_at &&
            new Date(user.expires_at) < new Date()
        ) {
            return res.status(403).json({
                message:
                    "To'lov muddati tugagan!"
            });
        }

        req.user = decoded;
        next();
    } catch (err) {
        console.error(
            'Token tekshirish xatosi:',
            err
        );
        return res.status(403).json({
            message:
                "Yaroqsiz yoki muddati o'tgan token!"
        });
    }
};

// ====================================================
// ME
// ====================================================

app.get(
    '/api/me',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    id,
                    telegram_id,
                    full_name,
                    username,
                    site_login,
                    is_paid,
                    expires_at
                FROM public.users
                WHERE id = $1
                LIMIT 1
                `,
                [req.user.userId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({
                    message:
                        'Foydalanuvchi topilmadi!'
                });
            }

            res.json({
                user: result.rows[0]
            });
        } catch (err) {
            console.error(
                '/api/me xatosi:',
                err
            );
            res.status(500).json({
                message:
                    'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// DASHBOARD STATS
// ====================================================

app.get(
    '/api/dashboard/stats',
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            let storeName = '';

            const userResult = await pool.query(
                `
                SELECT
                    full_name,
                    site_login
                FROM public.users
                WHERE id = $1
                LIMIT 1
                `,
                [userId]
            );

            if (userResult.rows.length > 0) {
                storeName =
                    userResult.rows[0].full_name ||
                    userResult.rows[0].site_login ||
                    '';
            }

            const productStats = await pool.query(
                `
                SELECT
                    COUNT(DISTINCT local_id) AS "totalProducts",
                    COALESCE(SUM(quantity), 0) AS "totalStock",
                    COALESCE(SUM(quantity * cost_price), 0) AS "totalStockValue"
                FROM public.products
                WHERE user_id = $1
                `,
                [userId]
            );

            const debtStats = await pool.query(
                `
                SELECT COALESCE(SUM(debt), 0) AS "totalDebt"
                FROM (
                    SELECT
                        GREATEST(
                            SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                            0
                        ) AS debt
                    FROM public.products
                    WHERE user_id = $1
                      AND payment_type = 'credit'
                    GROUP BY local_id
                ) t
                `,
                [userId]
            );

            // Mijoz qarzi (nasiyaga sotilganlardan)
            const customerDebtStats = await pool.query(
                `
                SELECT COALESCE(SUM(quantity * selling_price - COALESCE(paid_now, 0)), 0) AS "totalCustomerDebt"
                FROM public.sales
                WHERE user_id = $1
                  AND is_credit = true
                  AND returned = false
                `,
                [userId]
            );

            const getPeriodStats = async (
                salesFilter,
                expenseFilter
            ) => {
                const sales = await pool.query(
                    `
                    SELECT
                        COALESCE(SUM(quantity), 0) AS sold,
                        COALESCE(SUM(quantity * selling_price), 0) AS revenue,
                        COALESCE(SUM(profit), 0) AS gross_profit
                    FROM public.sales
                    WHERE
                        user_id = $1
                        AND returned = false
                        AND ${salesFilter}
                    `,
                    [userId]
                );

                const expenses = await pool.query(
                    `
                    SELECT
                        COALESCE(SUM(amount), 0) AS expense
                    FROM public.expenses
                    WHERE
                        user_id = $1
                        AND ${expenseFilter}
                    `,
                    [userId]
                );

                const sold = Number(sales.rows[0].sold || 0);
                const revenue = Number(sales.rows[0].revenue || 0);
                const grossProfit = Number(sales.rows[0].gross_profit || 0);
                const expense = Number(expenses.rows[0].expense || 0);

                return {
                    sold,
                    revenue,
                    expense,
                    profit: grossProfit - expense
                };
            };

            const daily = await getPeriodStats(
                `sold_at::date = CURRENT_DATE`,
                `created_at::date = CURRENT_DATE`
            );

            const monthly = await getPeriodStats(
                `date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)`,
                `date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
            );

            const yearly = await getPeriodStats(
                `date_trunc('year', sold_at) = date_trunc('year', CURRENT_DATE)`,
                `date_trunc('year', created_at) = date_trunc('year', CURRENT_DATE)`
            );

            const total = await getPeriodStats(
                `TRUE`,
                `TRUE`
            );

            res.json({
                storeName,
                totalProducts: Number(productStats.rows[0].totalProducts || 0),
                totalStock: Number(productStats.rows[0].totalStock || 0),
                totalStockValue: Number(productStats.rows[0].totalStockValue || 0),
                totalDebt: Number(debtStats.rows[0].totalDebt || 0),
                totalCustomerDebt: Number(customerDebtStats.rows[0].totalCustomerDebt || 0),
                totalSold: total.sold,
                totalRevenue: total.revenue,
                totalProfit: total.profit,
                totalExpense: total.expense,
                dailySold: daily.sold,
                dailyRevenue: daily.revenue,
                dailyProfit: daily.profit,
                dailyExpense: daily.expense,
                monthlySold: monthly.sold,
                monthlyRevenue: monthly.revenue,
                monthlyProfit: monthly.profit,
                monthlyExpense: monthly.expense,
                yearlySold: yearly.sold,
                yearlyRevenue: yearly.revenue,
                yearlyProfit: yearly.profit,
                yearlyExpense: yearly.expense
            });
        } catch (err) {
            console.error(
                'Stats xatosi:',
                err
            );
            res.status(500).json({
                message:
                    'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// TOVAR QO'SHISH
// ====================================================

app.post(
    '/api/products',
    authenticateToken,
    async (req, res) => {
        const {
            category,
            name,
            cost_price,
            color,
            quantity,
            sizes,
            payment_type,
            supplier,
            paid_amount,
            supplier_phone,
            selling_price,
            image_url
        } = req.body || {};

        if (
            !name ||
            cost_price === undefined
        ) {
            return res.status(400).json({
                message:
                    "Tovar nomi va kelgan narxi kiritilishi shart!"
            });
        }

        if (!category || !String(category).trim()) {
            return res.status(400).json({
                message:
                    "Kategoriya kiritilishi shart!"
            });
        }

        const parsedCostPrice = Number(cost_price);

        if (
            !Number.isFinite(parsedCostPrice) ||
            parsedCostPrice < 0
        ) {
            return res.status(400).json({
                message:
                    "Kelgan narx noto'g'ri!"
            });
        }

        const totalQty = parseInt(quantity, 10) || 0;

        if (totalQty <= 0) {
            return res.status(400).json({
                message:
                    "Soni 0 dan katta bo'lishi kerak!"
            });
        }

        const cleanPaymentType =
            payment_type === 'credit' ? 'credit' : 'cash';

        let cleanSupplier =
            typeof supplier === 'string'
                ? supplier.trim()
                : '';
        // Kimdan / telefon — ixtiyoriy (bo'sh bo'lishi mumkin)

        let cleanSupplierPhone =
            typeof supplier_phone === 'string'
                ? supplier_phone.trim()
                : '';

        if (!cleanSupplierPhone) {
            return res.status(400).json({
                message:
                    "Telefon raqamini kiritish shart!"
            });
        }

        let parsedPaidAmount = 0;

        if (cleanPaymentType === 'credit') {
            if (paid_amount !== undefined && paid_amount !== null && paid_amount !== '') {
                const n = Number(paid_amount);
                if (!Number.isFinite(n) || n < 0) {
                    return res.status(400).json({
                        message:
                            "To'langan summa noto'g'ri!"
                    });
                }
                parsedPaidAmount = n;
            } else {
                parsedPaidAmount = 0;
            }
        }

        let parsedSellingPrice = null;
        if (selling_price !== undefined && selling_price !== null && selling_price !== '') {
            parsedSellingPrice = Number(selling_price);
            if (!Number.isFinite(parsedSellingPrice) || parsedSellingPrice < 0) {
                return res.status(400).json({
                    message: "Sotilish narxi noto'g'ri!"
                });
            }
        }

        // Rasm (ixtiyoriy) — data:image/... yoki https URL
        let cleanImageUrl = null;
        if (typeof image_url === 'string' && image_url.trim()) {
            cleanImageUrl = image_url.trim();
            // ~700KB limit (base64)
            if (cleanImageUrl.length > 900000) {
                return res.status(400).json({
                    message: "Rasm juda katta! Iltimos, kichikroq rasm yuklang."
                });
            }
        }

        const userId = req.user.userId;

        // ===== YANGI: size_quantities (frontenddan aniq taqsimot) =====
        let exactQuantities = null;
        if (Array.isArray(req.body.size_quantities) && req.body.size_quantities.length > 0) {
            exactQuantities = req.body.size_quantities
                .map(item => ({
                    size: typeof item.size === 'string' ? item.size.trim() : '',
                    quantity: Math.max(0, parseInt(item.quantity, 10) || 0)
                }))
                .filter(item => item.quantity > 0);

            if (exactQuantities.length === 0) {
                return res.status(400).json({ message: "Kamida bitta razmer uchun son > 0 bo‘lishi kerak!" });
            }
        }


        let sizeList = [];

        if (
            !exactQuantities && sizes &&
            typeof sizes === 'string'
        ) {
            const seen = new Set();
            sizes
                .split(',')
                .forEach((item) => {
                    const clean = item.trim();
                    if (
                        clean &&
                        !seen.has(
                            clean.toLowerCase()
                        )
                    ) {
                        seen.add(
                            clean.toLowerCase()
                        );
                        sizeList.push(
                            clean
                        );
                    }
                });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const last = await client.query(
                `
                SELECT local_id
                FROM public.products
                WHERE user_id = $1
                ORDER BY local_id DESC, id DESC
                LIMIT 1
                `,
                [userId]
            );

            const nextLocalId =
                last.rows.length
                    ? Number(
                        last.rows[0].local_id
                    ) + 1
                    : 1;

            const insertedRows = [];

            if (exactQuantities) {
                // Har bir dona uchun alohida qator + alohida QR
                for (const item of exactQuantities) {
                    const qty = Math.max(1, parseInt(item.quantity, 10) || 1);
                    for (let u = 0; u < qty; u++) {
                        const result = await client.query(
                            `
                            INSERT INTO public.products
                            (
                                user_id, local_id, category, name, cost_price, color, size, quantity,
                                qr_token, qr_created_at, payment_type, supplier, paid_amount,
                                supplier_phone, selling_price, image_url
                            )
                            VALUES
                            (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(),
                                $10, $11, $12, $13, $14, $15
                            )
                            RETURNING *
                            `,
                            [
                                userId,
                                nextLocalId,
                                String(category).trim(),
                                String(name).trim(),
                                parsedCostPrice,
                                color || null,
                                item.size || null,
                                1,  // har bir qator = 1 dona
                                randomUUID(),
                                cleanPaymentType,
                                cleanSupplier,
                                parsedPaidAmount,
                                cleanSupplierPhone,
                                parsedSellingPrice,
                                cleanImageUrl
                            ]
                        );
                        insertedRows.push(result.rows[0]);
                    }
                }
            } else if (
                sizeList.length === 0
            ) {
                // Har bir dona uchun alohida QR
                for (let u = 0; u < totalQty; u++) {
                    const result = await client.query(
                        `
                        INSERT INTO public.products
                        (
                            user_id, local_id, category, name, cost_price, color, size, quantity,
                            qr_token, qr_created_at, payment_type, supplier, paid_amount,
                            supplier_phone, selling_price, image_url
                        )
                        VALUES
                        (
                            $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(),
                            $10, $11, $12, $13, $14, $15
                        )
                        RETURNING *
                        `,
                        [
                            userId,
                            nextLocalId,
                            String(category).trim(),
                            String(name).trim(),
                            parsedCostPrice,
                            color || null,
                            null,
                            1,
                            randomUUID(),
                            cleanPaymentType,
                            cleanSupplier,
                            parsedPaidAmount,
                            cleanSupplierPhone,
                            parsedSellingPrice,
                            cleanImageUrl
                        ]
                    );
                    insertedRows.push(result.rows[0]);
                }
            } else {
                // Teng taqsimot: har bir dona uchun alohida QR
                const count = sizeList.length;
                const base = Math.floor(totalQty / count);
                const remainder = totalQty % count;

                for (let i = 0; i < count; i++) {
                    const sizeQty = base + (i < remainder ? 1 : 0);
                    for (let u = 0; u < sizeQty; u++) {
                        const result = await client.query(
                            `
                            INSERT INTO public.products
                            (
                                user_id, local_id, category, name, cost_price, color, size, quantity,
                                qr_token, qr_created_at, payment_type, supplier, paid_amount,
                                supplier_phone, selling_price, image_url
                            )
                            VALUES
                            (
                                $1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(),
                                $10, $11, $12, $13, $14, $15
                            )
                            RETURNING *
                            `,
                            [
                                userId,
                                nextLocalId,
                                String(category).trim(),
                                String(name).trim(),
                                parsedCostPrice,
                                color || null,
                                sizeList[i],
                                1,
                                randomUUID(),
                                cleanPaymentType,
                                cleanSupplier,
                                parsedPaidAmount,
                                cleanSupplierPhone,
                                parsedSellingPrice,
                                cleanImageUrl
                            ]
                        );
                        insertedRows.push(result.rows[0]);
                    }
                }
            }

            const userResult = await client.query(
                `
                SELECT site_login
                FROM public.users
                WHERE id = $1
                LIMIT 1
                `,
                [userId]
            );

            if (
                userResult.rows.length
            ) {
                const siteLogin =
                    userResult.rows[0]
                        .site_login;

                const first = insertedRows[0];

                let sizesBlock = '';

                if (
                    sizeList.length
                ) {
                    const lines =
                        insertedRows
                            .map(
                                (row) =>
                                    `   • ${telegramEscape(row.size)}: ${row.quantity} dona`
                            )
                            .join('\n');

                    sizesBlock =
                        `\n📏 <b>Razmerlar bo'yicha taqsimot:</b>\n${lines}`;
                }

                let paymentInfo = '';
                if (cleanPaymentType === 'credit') {
                    paymentInfo =
                        `\n💳 <b>To'lov turi:</b> Nasiya\n` +
                        `👤 <b>Kimdan:</b> ${telegramEscape(cleanSupplier || "Ko'rsatilmagan")}\n` +
                        (cleanSupplierPhone ? `📞 <b>Telefon:</b> ${telegramEscape(cleanSupplierPhone)}\n` : '') +
                        `💵 <b>To'langan:</b> ${formatSum(parsedPaidAmount)} so'm\n` +
                        `📉 <b>Qarz:</b> ${formatSum(Math.max(0, (parsedCostPrice * totalQty) - parsedPaidAmount))} so'm`;
                } else {
                    paymentInfo =
                        `\n💳 <b>To'lov turi:</b> Naqd\n` +
                        `👤 <b>Kimdan:</b> ${telegramEscape(cleanSupplier)}\n` +
                        `📞 <b>Telefon:</b> ${telegramEscape(cleanSupplierPhone)}`;
                }

                let message =
                    `🆕 <b>YANGI MAHSULOT QO'SHILDI (#${nextLocalId})</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Nomi:</b> ${telegramEscape(first.name)}\n` +
                    `🎨 <b>Rangi:</b> ${telegramEscape(first.color || "Yo'q")}\n` +
                    `🗂 <b>Kategoriyasi:</b> ${telegramEscape(first.category || "Yo'q")}\n` +
                    `💰 <b>Narxi:</b> ${formatSum(first.cost_price)} so'm` +
                    paymentInfo +
                    `\n📊 <b>Umumiy miqdori:</b> ${totalQty} dona` +
                    sizesBlock +
                    `\n━━━━━━━━━━━━━━━━━━━━\n` +
                    `✅ Ombor yangilandi!`;

                message +=
                    await getTodayReport(
                        client,
                        userId
                    );

                await queueTelegramNotification(
                    client,
                    siteLogin,
                    message,
                    cleanImageUrl
                );
            }

            await client.query('COMMIT');

            res.status(201).json({
                message:
                    exactQuantities
                        ? `Tovar saqlandi! ${exactQuantities.length} ta razmer bo'yicha aniq taqsimlandi (ID: #${nextLocalId})`
                        : sizeList.length
                            ? `Tovar saqlandi! ${sizeList.length} ta razmer bo'yicha taqsimlandi (ID: #${nextLocalId})`
                            : `Tovar saqlandi! ID: #${nextLocalId}`,
                product: insertedRows[0],
                products: insertedRows,
                local_id: nextLocalId
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (rollbackError) {
                console.error(
                    'ROLLBACK xatosi:',
                    rollbackError
                );
            }

            console.error(
                "Tovar qo'shishda xatolik:",
                err
            );

            res.status(500).json({
                message:
                    "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// TOVARLAR
// ====================================================

app.get(
    '/api/products',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    id,
                    user_id,
                    local_id,
                    category,
                    name,
                    name AS title,
                    cost_price,
                    color,
                    size,
                    quantity,
                    qr_token,
                    qr_created_at,
                    created_at,
                    payment_type,
                    supplier,
                    paid_amount,
                    supplier_phone,
                    selling_price,
                    image_url
                FROM public.products
                WHERE user_id = $1
                ORDER BY
                    local_id DESC,
                    CASE
                        WHEN size ~ '^[0-9]+$'
                        THEN size::int
                    END ASC NULLS LAST,
                    size ASC NULLS LAST,
                    id ASC
                `,
                [req.user.userId]
            );

            res.json({
                products: result.rows
            });
        } catch (err) {
            console.error(
                'Tovarlarni olish xatosi:',
                err
            );
            res.status(500).json({
                message:
                    'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// QARZLAR RO'YXATI (Tovar berganlar — to'g'ri hisob)
// ====================================================
app.get('/api/debts', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const result = await pool.query(
            `
            SELECT
                COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum') AS supplier,
                MAX(NULLIF(TRIM(supplier_phone), '')) AS supplier_phone,
                SUM(cost_price * quantity) AS total_cost,
                MAX(COALESCE(paid_amount, 0)) AS total_paid,
                GREATEST(
                    SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                    0
                ) AS debt,
                COUNT(DISTINCT local_id) AS products_count,
                array_agg(DISTINCT category) FILTER (WHERE category IS NOT NULL AND TRIM(category) <> '') AS categories
            FROM public.products
            WHERE user_id = $1
              AND payment_type = 'credit'
              AND supplier IS NOT NULL
              AND TRIM(supplier) <> ''
            GROUP BY COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum')
            HAVING GREATEST(
                SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                0
            ) > 0
            ORDER BY debt DESC
            `,
            [userId]
        );

        const debts = result.rows.map((row) => ({
            supplier: row.supplier,
            supplier_phone: row.supplier_phone || null,
            total_cost: Number(row.total_cost) || 0,
            total_paid: Number(row.total_paid) || 0,
            debt: Number(row.debt) || 0,
            products_count: Number(row.products_count) || 0,
            categories: row.categories || []
        }));

        res.json({ debts });
    } catch (err) {
        console.error('Qarzlarni olish xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    }
});

// ====================================================
// YANGI: OXIRGI TO'LOVLAR (bekor qilish uchun)
// ====================================================

app.get(
    '/api/debts/recent-payments',
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            // To'lov qilingan (paid_amount > 0) barcha nasiya tovarlar
            const result = await pool.query(
                `
                SELECT
                    local_id,
                    MAX(name) AS name,
                    MAX(category) AS category,
                    MAX(color) AS color,
                    MAX(supplier) AS supplier,
                    MAX(supplier_phone) AS supplier_phone,
                    SUM(quantity) AS total_quantity,
                    SUM(cost_price * quantity) AS total_cost,
                    MAX(COALESCE(paid_amount, 0)) AS total_paid,
                    GREATEST(
                        SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                        0
                    ) AS debt,
                    MAX(created_at) AS last_created
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND COALESCE(paid_amount, 0) > 0
                GROUP BY local_id
                ORDER BY MAX(created_at) DESC
                `,
                [userId]
            );

            // Bir xil supplier bo'yicha guruhlash
            const grouped = {};

            for (const row of result.rows) {
                const supplierName = (row.supplier || "Noma'lum").trim();
                const phone = (row.supplier_phone || '').trim();
                const key = supplierName.toLowerCase() + '|' + phone;

                if (!grouped[key]) {
                    grouped[key] = {
                        supplier: supplierName,
                        supplier_phone: phone || null,
                        total_debt: 0,
                        total_cost: 0,
                        total_paid: 0,
                        products_count: 0,
                        products: [],
                        last_created: row.last_created
                    };
                }

                const debt = Number(row.debt) || 0;
                const cost = Number(row.total_cost) || 0;
                const paid = Number(row.total_paid) || 0;

                grouped[key].total_debt += debt;
                grouped[key].total_cost += cost;
                grouped[key].total_paid += paid;
                grouped[key].products_count += 1;
                grouped[key].products.push({
                    local_id: row.local_id,
                    name: row.name,
                    category: row.category || 'Umumiy',
                    color: row.color || null,
                    quantity: Number(row.total_quantity) || 0,
                    total_cost: cost,
                    total_paid: paid,
                    debt: debt
                });

                if (row.last_created && (!grouped[key].last_created || new Date(row.last_created) > new Date(grouped[key].last_created))) {
                    grouped[key].last_created = row.last_created;
                }
            }

            const payments = Object.values(grouped)
                .filter(p => Number(p.total_paid) > 0)
                .sort((a, b) => b.total_paid - a.total_paid);

            res.json({
                payments
            });
        } catch (err) {
            console.error('Recent payments xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// YANGI: TO'LOVNI BEKOR QILISH / TAHRIRLASH
// ====================================================

app.post(
    '/api/debts/undo-or-edit',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const { supplier, supplier_phone, amount, mode } = req.body || {};

        const cleanSupplier = typeof supplier === 'string' ? supplier.trim() : '';
        const parsedAmount = Number(amount);
        const actionMode = mode === 'edit' ? 'edit' : 'undo';

        if (!cleanSupplier) {
            return res.status(400).json({
                message: "Kimdan ekanligi ko'rsatilmagan!"
            });
        }

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                message: "Summa noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            // Shu supplierga tegishli nasiya tovarlarni olamiz
            const groupsResult = await client.query(
                `
                SELECT
                    local_id,
                    MAX(name) AS name,
                    SUM(cost_price * quantity) AS total_cost,
                    MAX(COALESCE(paid_amount, 0)) AS total_paid,
                    GREATEST(
                        SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                        0
                    ) AS debt,
                    MAX(created_at) AS created_at
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND supplier = $2
                GROUP BY local_id
                HAVING MAX(COALESCE(paid_amount, 0)) > 0
                ORDER BY local_id ASC
                `,
                [userId, cleanSupplier]
            );

            if (groupsResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Bu odamga tegishli to'langan qarz topilmadi!"
                });
            }

            // Muddat tekshiruvi (oxirgi 30 kun)
            const anyRecent = groupsResult.rows.some(g => daysSince(g.created_at) <= DEBT_PAYMENT_UNDO_WINDOW_DAYS);
            if (!anyRecent) {
                // Hali ham ruxsat beramiz, lekin ogohlantiramiz (yoki qattiq cheklash mumkin)
                // Hozircha ruxsat beramiz
            }

            let totalAdjusted = 0;
            const updatedProducts = [];

            if (actionMode === 'undo') {
                // To'lovni kamaytirish (qarzni tiklash)
                let remainingUndo = parsedAmount;

                for (const group of groupsResult.rows) {
                    if (remainingUndo <= 0) break;

                    const currentPaid = Number(group.total_paid) || 0;
                    if (currentPaid <= 0) continue;

                    const undoForThis = Math.min(remainingUndo, currentPaid);
                    const newPaidAmount = currentPaid - undoForThis;

                    await client.query(
                        `
                        UPDATE public.products
                        SET paid_amount = $1
                        WHERE user_id = $2
                          AND local_id = $3
                          AND payment_type = 'credit'
                        `,
                        [newPaidAmount, userId, group.local_id]
                    );

                    remainingUndo -= undoForThis;
                    totalAdjusted += undoForThis;

                    updatedProducts.push({
                        local_id: group.local_id,
                        name: group.name,
                        adjusted: undoForThis,
                        new_paid: newPaidAmount
                    });
                }

                if (totalAdjusted <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        message: "Bekor qilish amalga oshmadi!"
                    });
                }
            } else {
                // Edit mode: barcha local_id lar uchun paid_amount ni yangi qiymatga o'zgartirish
                // (soddalashtirilgan: birinchi groupga qo'llaymiz yoki proporsional)
                // Eng oddiy: barcha grouplar uchun bir xil yangi paid_amount qo'yamiz (yoki faqat bitta)
                // Hozircha: umumiy paid ni o'zgartirish uchun birinchi local_id ga yozamiz

                const first = groupsResult.rows[0];
                const oldPaid = Number(first.total_paid) || 0;

                await client.query(
                    `
                    UPDATE public.products
                    SET paid_amount = $1
                    WHERE user_id = $2
                      AND local_id = $3
                      AND payment_type = 'credit'
                    `,
                    [parsedAmount, userId, first.local_id]
                );

                // Boshqa local_id larni 0 qilish (sodda yondashuv)
                for (let i = 1; i < groupsResult.rows.length; i++) {
                    await client.query(
                        `
                        UPDATE public.products
                        SET paid_amount = 0
                        WHERE user_id = $1
                          AND local_id = $2
                          AND payment_type = 'credit'
                        `,
                        [userId, groupsResult.rows[i].local_id]
                    );
                }

                totalAdjusted = parsedAmount;
                updatedProducts.push({
                    local_id: first.local_id,
                    name: first.name,
                    adjusted: parsedAmount,
                    new_paid: parsedAmount
                });
            }

            // Qolgan qarz
            const remainingDebtResult = await client.query(
                `
                SELECT COALESCE(SUM(debt), 0) AS remaining
                FROM (
                    SELECT
                        GREATEST(
                            SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                            0
                        ) AS debt
                    FROM public.products
                    WHERE user_id = $1
                      AND payment_type = 'credit'
                      AND supplier = $2
                    GROUP BY local_id
                ) t
                `,
                [userId, cleanSupplier]
            );

            const remainingDebt = Number(remainingDebtResult.rows[0].remaining || 0);

            // Telegram
            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1 LIMIT 1`,
                [userId]
            );

            const siteLogin = userResult.rows[0]?.site_login || null;

            if (siteLogin) {
                let productsBlock = updatedProducts
                    .map(p => `   • #${p.local_id} ${telegramEscape(p.name)}: ${formatSum(p.adjusted)} so'm`)
                    .join('\n');

                let message =
                    (actionMode === 'undo'
                        ? `↩️ <b>QARZ TO'LOVI BEKOR QILINDI</b>\n`
                        : `✏️ <b>QARZ TO'LOVI TAHRIRLANDI</b>\n`) +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `👤 <b>Kimga:</b> ${telegramEscape(cleanSupplier)}\n` +
                    (supplier_phone ? `📞 <b>Telefon:</b> ${telegramEscape(supplier_phone)}\n` : '') +
                    `💵 <b>${actionMode === 'undo' ? 'Bekor qilingan' : 'Yangi to\'langan'} summa:</b> ${formatSum(totalAdjusted)} so'm\n` +
                    `📉 <b>Qolgan qarz:</b> ${formatSum(remainingDebt)} so'm\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Taqsimot:</b>\n${productsBlock}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;

                message += await getTodayReport(client, userId);

                await queueTelegramNotification(client, siteLogin, message);
            }

            await client.query('COMMIT');

            res.json({
                message: actionMode === 'undo'
                    ? `${formatSum(totalAdjusted)} so'm to'lov bekor qilindi. Qolgan qarz: ${formatSum(remainingDebt)} so'm`
                    : `To'langan summa yangilandi. Qolgan qarz: ${formatSum(remainingDebt)} so'm`,
                adjusted: totalAdjusted,
                remaining_debt: remainingDebt
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('Undo/Edit debt xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QARZNI TO'LASH
// ====================================================

app.post(
    '/api/debts/pay',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const { supplier, supplier_phone, amount } = req.body || {};

        const cleanSupplier = typeof supplier === 'string' ? supplier.trim() : '';
        const parsedAmount = Number(amount);

        if (!cleanSupplier) {
            return res.status(400).json({
                message: "Kimdan ekanligi ko'rsatilmagan!"
            });
        }

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                message: "To'lov summasi noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const groupsResult = await client.query(
                `
                SELECT
                    local_id,
                    MAX(name) AS name,
                    SUM(cost_price * quantity) AS total_cost,
                    MAX(COALESCE(paid_amount, 0)) AS total_paid,
                    GREATEST(
                        SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                        0
                    ) AS debt
                FROM public.products
                WHERE user_id = $1
                  AND payment_type = 'credit'
                  AND supplier = $2
                GROUP BY local_id
                HAVING SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)) > 0
                ORDER BY local_id ASC
                `,
                [userId, cleanSupplier]
            );

            if (groupsResult.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Bu odamga tegishli qarz topilmadi!"
                });
            }

            let remainingPay = parsedAmount;
            let totalPaidNow = 0;
            const updatedProducts = [];

            for (const group of groupsResult.rows) {
                if (remainingPay <= 0) break;

                const currentDebt = Number(group.debt) || 0;
                if (currentDebt <= 0) continue;

                const payForThis = Math.min(remainingPay, currentDebt);
                const newPaidAmount = Number(group.total_paid || 0) + payForThis;

                await client.query(
                    `
                    UPDATE public.products
                    SET paid_amount = $1
                    WHERE user_id = $2
                      AND local_id = $3
                      AND payment_type = 'credit'
                    `,
                    [newPaidAmount, userId, group.local_id]
                );

                remainingPay -= payForThis;
                totalPaidNow += payForThis;

                updatedProducts.push({
                    local_id: group.local_id,
                    name: group.name,
                    size: null,
                    paid: payForThis,
                    remaining_debt: currentDebt - payForThis
                });
            }

            if (totalPaidNow <= 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    message: "To'lov amalga oshirilmadi!"
                });
            }

            const remainingDebtResult = await client.query(
                `
                SELECT COALESCE(SUM(debt), 0) AS remaining
                FROM (
                    SELECT
                        GREATEST(
                            SUM(cost_price * quantity) - MAX(COALESCE(paid_amount, 0)),
                            0
                        ) AS debt
                    FROM public.products
                    WHERE user_id = $1
                      AND payment_type = 'credit'
                      AND supplier = $2
                    GROUP BY local_id
                ) t
                `,
                [userId, cleanSupplier]
            );

            const remainingDebt = Number(remainingDebtResult.rows[0].remaining || 0);

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1 LIMIT 1`,
                [userId]
            );

            const siteLogin = userResult.rows[0]?.site_login || null;

            if (siteLogin) {
                let productsBlock = updatedProducts
                    .map(p => `   • #${p.local_id} ${telegramEscape(p.name)}${p.size ? ' (' + telegramEscape(p.size) + ')' : ''}: ${formatSum(p.paid)} so'm`)
                    .join('\n');

                let message =
                    `💰 <b>QARZ TO'LANDI</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `👤 <b>Kimga:</b> ${telegramEscape(cleanSupplier)}\n` +
                    (supplier_phone ? `📞 <b>Telefon:</b> ${telegramEscape(supplier_phone)}\n` : '') +
                    `💵 <b>To'langan summa:</b> ${formatSum(totalPaidNow)} so'm\n` +
                    `📉 <b>Qolgan qarz:</b> ${formatSum(remainingDebt)} so'm\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>To'lov taqsimoti:</b>\n${productsBlock}\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;

                message += await getTodayReport(client, userId);

                await queueTelegramNotification(client, siteLogin, message);
            }

            await client.query('COMMIT');

            res.json({
                message: `${formatSum(totalPaidNow)} so'm qarz muvaffaqiyatli to'landi! Qolgan qarz: ${formatSum(remainingDebt)} so'm`,
                paid: totalPaidNow,
                remaining_debt: remainingDebt
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('Qarz to\'lashda xatolik:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// TOVAR BERGANLAR (SUPPLIERS) RO'YXATI
// ====================================================

app.get(
    '/api/suppliers',
    authenticateToken,
    async (req, res) => {
        try {
            const userId = req.user.userId;

            const result = await pool.query(
                `
                SELECT
                    COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum') AS supplier,
                    MAX(NULLIF(TRIM(supplier_phone), '')) AS supplier_phone,
                    COUNT(DISTINCT local_id) AS products_count,
                    COALESCE(SUM(cost_price * quantity), 0) AS total_cost,
                    COALESCE(SUM(quantity), 0) AS total_quantity,
                    array_agg(DISTINCT category) FILTER (
                        WHERE category IS NOT NULL AND TRIM(category) <> ''
                    ) AS categories,
                    json_agg(
                        json_build_object(
                            'local_id', local_id,
                            'name', name,
                            'category', category,
                            'color', color,
                            'size', size,
                            'quantity', quantity,
                            'cost_price', cost_price,
                            'payment_type', payment_type,
                            'created_at', created_at
                        )
                        ORDER BY local_id DESC, size ASC NULLS LAST
                    ) AS products
                FROM public.products
                WHERE user_id = $1
                  AND supplier IS NOT NULL
                  AND TRIM(supplier) <> ''
                GROUP BY COALESCE(NULLIF(TRIM(supplier), ''), 'Noma''lum')
                ORDER BY MAX(created_at) DESC NULLS LAST, supplier ASC
                `,
                [userId]
            );

            const suppliers = result.rows.map((row) => ({
                supplier: row.supplier,
                supplier_phone: row.supplier_phone || null,
                products_count: Number(row.products_count) || 0,
                product_count: Number(row.products_count) || 0, // frontend uchun alias
                total_cost: Number(row.total_cost) || 0,
                total_quantity: Number(row.total_quantity) || 0,
                categories: Array.isArray(row.categories) ? row.categories.filter(Boolean) : [],
                products: Array.isArray(row.products) ? row.products : []
            }));

            res.json({
                suppliers
            });
        } catch (err) {
            console.error('Tovar berganlarni olish xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// TOVARNI TAHRIRLASH (PUT /api/products/:localId) — TO'LIQ TUZATILGAN
// ====================================================
app.put('/api/products/:localId', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const localId = Number(req.params.localId);

    if (!Number.isInteger(localId) || localId <= 0) {
        return res.status(400).json({ message: "Tovar ID noto'g'ri!" });
    }

    const {
        category, name, color, cost_price, quantity, sizes,
        selling_price, image_url
    } = req.body || {};

    if (!name || !String(name).trim()) {
        return res.status(400).json({ message: "Tovar nomi kiritilishi shart!" });
    }

    const parsedCostPrice = Number(cost_price);
    if (!Number.isFinite(parsedCostPrice) || parsedCostPrice < 0) {
        return res.status(400).json({ message: "Tannarx noto'g'ri!" });
    }

    const totalQty = parseInt(quantity, 10);
    if (!Number.isInteger(totalQty) || totalQty < 0) {
        return res.status(400).json({ message: "Tovar soni noto'g'ri!" });
    }

    let parsedSellingPrice = null;
    if (selling_price !== undefined && selling_price !== null && selling_price !== '') {
        parsedSellingPrice = Number(selling_price);
        if (!Number.isFinite(parsedSellingPrice) || parsedSellingPrice < 0) {
            return res.status(400).json({ message: "Sotish narxi noto'g'ri!" });
        }
    }

    let cleanImageUrl = null;
    if (typeof image_url === 'string' && image_url.trim()) {
        cleanImageUrl = image_url.trim();
        if (cleanImageUrl.length > 900000) {
            return res.status(400).json({ message: "Rasm juda katta!" });
        }
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        // Eski holatni olish (barcha variantlar)
        const oldRes = await client.query(
            `SELECT * FROM public.products WHERE user_id = $1 AND local_id = $2 ORDER BY id`,
            [userId, localId]
        );

        if (!oldRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Tovar topilmadi!" });
        }

        const oldFirst = oldRes.rows[0];
        if (daysSince(oldFirst.created_at) > PRODUCT_EDIT_WINDOW_DAYS) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                message: `Bu tovar qo'shilganiga ${PRODUCT_EDIT_WINDOW_DAYS} kundan ko'p vaqt o'tgan, tahrirlab bo'lmaydi!`
            });
        }

        const oldTotalQty = oldRes.rows.reduce((s, r) => s + Number(r.quantity || 0), 0);
        const oldSizes = oldRes.rows.map(r => r.size || 'Standart').join(', ');
        const oldImage = oldFirst.image_url || null;

        // Eski variantlarni o'chirish
        await client.query(
            `DELETE FROM public.products WHERE user_id = $1 AND local_id = $2`,
            [userId, localId]
        );

        // Yangi razmerlar
        let sizeList = [];
        if (sizes && typeof sizes === 'string') {
            const seen = new Set();
            sizes.split(',').forEach((item) => {
                const clean = item.trim();
                if (clean && !seen.has(clean.toLowerCase())) {
                    seen.add(clean.toLowerCase());
                    sizeList.push(clean);
                }
            });
        }

        const insertedRows = [];

        if (sizeList.length === 0) {
            const result = await client.query(
                `
                INSERT INTO public.products
                (user_id, local_id, category, name, cost_price, color, size, quantity,
                 qr_token, qr_created_at, payment_type, supplier, paid_amount,
                 supplier_phone, selling_price, image_url, created_at)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13,$14,$15,$16)
                RETURNING *
                `,
                [
                    userId, localId, String(category || 'Umumiy').trim(), String(name).trim(),
                    parsedCostPrice, color || null, null, totalQty,
                    randomUUID(), oldFirst.payment_type || 'cash', oldFirst.supplier,
                    oldFirst.paid_amount || 0, oldFirst.supplier_phone,
                    parsedSellingPrice, cleanImageUrl || oldImage, oldFirst.created_at
                ]
            );
            insertedRows.push(result.rows[0]);
        } else {
            const count = sizeList.length;
            const base = Math.floor(totalQty / count);
            const remainder = totalQty % count;

            for (let i = 0; i < count; i++) {
                const sizeQty = base + (i < remainder ? 1 : 0);
                const result = await client.query(
                    `
                    INSERT INTO public.products
                    (user_id, local_id, category, name, cost_price, color, size, quantity,
                     qr_token, qr_created_at, payment_type, supplier, paid_amount,
                     supplier_phone, selling_price, image_url, created_at)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13,$14,$15,$16)
                    RETURNING *
                    `,
                    [
                        userId, localId, String(category || 'Umumiy').trim(), String(name).trim(),
                        parsedCostPrice, color || null, sizeList[i], sizeQty,
                        randomUUID(), oldFirst.payment_type || 'cash', oldFirst.supplier,
                        oldFirst.paid_amount || 0, oldFirst.supplier_phone,
                        parsedSellingPrice, cleanImageUrl || oldImage, oldFirst.created_at
                    ]
                );
                insertedRows.push(result.rows[0]);
            }
        }

        // Telegram xabar (eski → yangi + rasm)
        const userResult = await client.query(
            `SELECT site_login FROM public.users WHERE id = $1`,
            [userId]
        );
        const siteLogin = userResult.rows[0]?.site_login || null;

        if (siteLogin) {
            const newFirst = insertedRows[0];
            const newSizes = insertedRows.map(r => `${r.size || 'Standart'}: ${r.quantity}`).join(', ');

            let message =
                `✏️ <b>TOVAR TAHRIRLANDI (#${localId})</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(oldFirst.name)} → <b>${telegramEscape(newFirst.name)}</b>\n` +
                `🗂 <b>Kategoriya:</b> ${telegramEscape(oldFirst.category || '—')} → ${telegramEscape(newFirst.category || '—')}\n` +
                `🎨 <b>Rang:</b> ${telegramEscape(oldFirst.color || '—')} → ${telegramEscape(newFirst.color || '—')}\n` +
                `💰 <b>Tannarx:</b> ${formatSum(oldFirst.cost_price)} → ${formatSum(newFirst.cost_price)} so'm\n` +
                (parsedSellingPrice != null ? `💵 <b>Sotish narxi:</b> ${formatSum(parsedSellingPrice)} so'm\n` : '') +
                `📊 <b>Jami son:</b> ${oldTotalQty} → <b>${totalQty}</b> dona\n` +
                `📏 <b>Razmerlar:</b>\n   Eski: ${telegramEscape(oldSizes)}\n   Yangi: ${telegramEscape(newSizes)}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            message += await getTodayReport(client, userId);
            await queueTelegramNotification(client, siteLogin, message, cleanImageUrl || oldImage);
        }

        await client.query('COMMIT');

        res.json({
            message: "Tovar muvaffaqiyatli tahrirlandi!",
            product: insertedRows[0],
            products: insertedRows
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { }
        console.error("Tovarni tahrirlashda xatolik:", err);
        res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    } finally {
        client.release();
    }
});


// VOZVRAT — TOVARNI QAYTARISH (POST /api/sales/:saleId/return)
// ====================================================
app.post('/api/sales/:saleId/return', authenticateToken, async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const userId = req.user.userId;
        const saleId = parseInt(req.params.saleId, 10);

        const saleRes = await client.query(
            `SELECT * FROM public.sales WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [saleId, userId]
        );

        if (saleRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Sotuv topilmadi" });
        }

        const sale = saleRes.rows[0];

        if (sale.returned) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "Bu sotuv allaqachon qaytarilgan" });
        }

        if (daysSince(sale.sold_at) > SALE_RETURN_WINDOW_DAYS) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                message: `Qaytarish muddati (${SALE_RETURN_WINDOW_DAYS} kun) o'tgan.`
            });
        }

        // Sotuvni qaytarilgan deb belgilash
        await client.query(
            `UPDATE public.sales SET returned = true WHERE id = $1`,
            [saleId]
        );

        // Omborga sonini qaytarib qo'shish
        const prodRes = await client.query(
            `
            UPDATE public.products
            SET quantity = quantity + $1
            WHERE user_id = $2 AND local_id = $3
            RETURNING image_url
            `,
            [sale.quantity, userId, sale.local_id]
        );

        await client.query('COMMIT');

        // Rasm birinchi navbatda sotuvdan, bo'lmasa tovardan olinadi
        const returnImageUrl = sale.image_url || prodRes.rows[0]?.image_url || null;

        // 🟢 TELEGRAM NOTIFICATION (RASMI BILAN)
        try {
            const userRes = await pool.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
            const siteLogin = userRes.rows[0]?.site_login;

            if (siteLogin) {
                const msg =
                    `🔄 <b>TOVAR QAYTARILDI (VOZVRAT)</b>\n` +
                    `━━━━━━━━━━━━━━━━━━━━\n` +
                    `📦 <b>Tovar:</b> ${telegramEscape(sale.title)}\n` +
                    `🔢 <b>Soni:</b> ${sale.quantity} dona\n` +
                    `💰 <b>Qaytarilgan summa:</b> ${formatSum(sale.quantity * sale.selling_price)} so'm\n` +
                    `━━━━━━━━━━━━━━━━━━━━`;

                await queueTelegramNotification(pool, siteLogin, msg, returnImageUrl);
            }
        } catch (tgErr) {
            console.error('[Telegram] Vozvrat bildirishnomasida xatolik:', tgErr.message);
        }

        res.json({ message: "Tovar muvaffaqiyatli qaytarildi" });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('POST /api/sales/:saleId/return xatosi:', err);
        res.status(500).json({ message: "Serverda xatolik yuz berdi" });
    } finally {
        client.release();
    }
});

// ====================================================
// SOTUV (NAQD)
// ====================================================

app.post(
    '/api/dashboard/sell',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        let items = Array.isArray(req.body.items) ? req.body.items : null;

        if (!items || !items.length) {
            return res.status(400).json({
                message: "Kamida bitta tovar tanlanishi shart!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const normalizedItems = [];
            let totalQty = 0;
            let totalRevenue = 0;
            let totalProfit = 0;
            let firstProductName = null;
            let firstLocalId = null;
            let firstImageUrl = null;
            const soldLines = [];
            let anyFullySoldOut = false;
            const affectedLocalIds = new Set();

            for (const item of items) {
                const productId = Number(item.product_id);
                const qty = Number(item.sell_quantity);
                const price = Number(item.selling_price);

                if (!Number.isInteger(productId) || productId <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Tovar ID noto'g'ri!" });
                }
                if (!qty || qty <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Soni noto'g'ri!" });
                }
                if (!Number.isFinite(price) || price < 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Narx noto'g'ri!" });
                }

                const prodRes = await client.query(
                    `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                    [productId, userId]
                );

                if (!prodRes.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: `Tovar topilmadi! (ID: ${productId})` });
                }

                const product = prodRes.rows[0];
                const currentQty = Number(product.quantity) || 0;

                if (qty > currentQty) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        message: `Omborda yetarli tovar yo'q! (${product.name}: ${currentQty} dona)`
                    });
                }

                const cost = Number(product.cost_price) || 0;
                const profit = (price - cost) * qty;
                const newQty = currentQty - qty;

                // Sales insert
                await client.query(
                    `
INSERT INTO public.sales
(
    user_id,
    product_id,
    title,
    quantity,
    cost_price,
    selling_price,
    profit,
    local_id,
    category,
    color,
    size,
    image_url
)
VALUES
(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
)
                    `,
                    [
                        userId,
                        product.id,
                        product.name,
                        qty,
                        cost,
                        price,
                        profit,
                        product.local_id,
                        product.category,
                        product.color,
                        product.size,
                        product.image_url || null
                    ]
                );

                if (newQty === 0) {
                    await client.query(
                        `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                        [product.id, userId]
                    );
                    anyFullySoldOut = true;
                } else {
                    await client.query(
                        `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                        [newQty, product.id, userId]
                    );
                }

                totalQty += qty;
                totalRevenue += price * qty;
                totalProfit += profit;
                affectedLocalIds.add(Number(product.local_id));

                if (!firstProductName) {
                    firstProductName = product.name;
                    firstLocalId = product.local_id;
                    firstImageUrl = product.image_url || null;
                }

                soldLines.push(
                    `   • 📏 ${telegramEscape(product.size || 'Standart')}: ${qty} dona × ${formatSum(price)} so'm`
                );

                normalizedItems.push({
                    product_id: product.id,
                    qty,
                    price
                });
            }

            // User & Telegram
            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b>\n";
            try {
                const localIds = Array.from(affectedLocalIds);
                if (localIds.length) {
                    const remainingResult = await client.query(
                        `
                        SELECT local_id, size, quantity
                        FROM public.products
                        WHERE user_id = $1 AND local_id = ANY($2::int[])
                        ORDER BY local_id, size
                        `,
                        [userId, localIds]
                    );

                    if (remainingResult.rows.length === 0) {
                        remainingStockInfo += "❌ Mahsulot omborda qolmagan";
                    } else {
                        remainingStockInfo += remainingResult.rows
                            .map(r => `• ${telegramEscape(r.size || 'Standart')}: ${r.quantity} ta`)
                            .join('\n');
                    }
                }
            } catch (e) {
                remainingStockInfo += "❌ Ma'lumot topilmadi";
            }

            const titleLine = normalizedItems.length > 1
                ? `💰 <b>TOVAR SOTILDI — ${normalizedItems.length} TA RAZMER (#${firstLocalId})</b>`
                : `💰 <b>TOVAR SOTILDI (#${firstLocalId})</b>`;

            let sellMessage =
                `${titleLine}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(firstProductName)}\n` +
                `📏 <b>Razmerlar bo'yicha sotildi:</b>\n` +
                `${soldLines.join('\n')}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>Jami sotilgan:</b> ${totalQty} dona\n` +
                `💰 <b>Jami tushum:</b> ${formatSum(totalRevenue)} so'm\n` +
                `${totalProfit >= 0 ? '📈' : '📉'} <b>${totalProfit >= 0 ? 'Jami foyda' : 'Jami ziyon'}:</b> ${formatSum(Math.abs(totalProfit))} so'm\n` +
                remainingStockInfo +
                `\n━━━━━━━━━━━━━━━━━━━━\n` +
                (anyFullySoldOut ? `🗑 Ba'zi razmerlar ombordan butunlay chiqarildi\n` : '') +
                `🎉 Tabriklaymiz, savdo amalga oshdi!`;

            sellMessage += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, sellMessage, firstImageUrl);

            await client.query('COMMIT');

            return res.json({
                message: "Tovar(lar) muvaffaqiyatli sotildi",
                totalQty,
                totalRevenue,
                totalProfit,
                profit: totalProfit,
                itemsSold: normalizedItems.length
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('Sotishda xatolik:', err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// YANGI: NASIYAGA SOTISH
// ====================================================

app.post(
    '/api/dashboard/sell-credit',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const {
            items,
            customer_name,
            customer_phone,
            paid_now
        } = req.body || {};

        if (!Array.isArray(items) || !items.length) {
            return res.status(400).json({
                message: "Kamida bitta tovar tanlanishi shart!"
            });
        }

        const cleanCustomerName = typeof customer_name === 'string' ? customer_name.trim() : '';
        const cleanCustomerPhone = typeof customer_phone === 'string' ? customer_phone.trim() : '';
        const parsedPaidNow = Number(paid_now) || 0;

        if (!cleanCustomerName) {
            return res.status(400).json({
                message: "Mijoz ismini kiriting!"
            });
        }
        if (!cleanCustomerPhone) {
            return res.status(400).json({
                message: "Mijoz telefonini kiriting!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            let totalQty = 0;
            let totalRevenue = 0;
            let totalProfit = 0;
            let firstProductName = null;
            let firstLocalId = null;
            let firstImageUrl = null;
            const soldLines = [];
            let anyFullySoldOut = false;
            const affectedLocalIds = new Set();

            for (const item of items) {
                const productId = Number(item.product_id);
                const qty = Number(item.sell_quantity);
                const price = Number(item.selling_price);

                if (!Number.isInteger(productId) || productId <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Tovar ID noto'g'ri!" });
                }
                if (!qty || qty <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Soni noto'g'ri!" });
                }
                if (!Number.isFinite(price) || price < 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Narx noto'g'ri!" });
                }

                const prodRes = await client.query(
                    `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                    [productId, userId]
                );

                if (!prodRes.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: `Tovar topilmadi! (ID: ${productId})` });
                }

                const product = prodRes.rows[0];
                const currentQty = Number(product.quantity) || 0;

                if (qty > currentQty) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        message: `Omborda yetarli tovar yo'q! (${product.name}: ${currentQty} dona)`
                    });
                }

                const cost = Number(product.cost_price) || 0;
                const profit = (price - cost) * qty;
                const newQty = currentQty - qty;

                // Sales insert — nasiya belgisi bilan
                await client.query(
                    `
INSERT INTO public.sales
(
    user_id,
    product_id,
    title,
    quantity,
    cost_price,
    selling_price,
    profit,
    local_id,
    category,
    color,
    size,
    image_url,
    customer_name,
    customer_phone,
    is_credit,
    paid_now
)
VALUES
(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15
)
                    `,
                    [
                        userId,
                        product.id,
                        product.name,
                        qty,
                        cost,
                        price,
                        profit,
                        product.local_id,
                        product.category,
                        product.color,
                        product.size,
                        product.image_url || null,
                        cleanCustomerName,
                        cleanCustomerPhone,
                        parsedPaidNow
                    ]
                );

                if (newQty === 0) {
                    await client.query(
                        `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                        [product.id, userId]
                    );
                    anyFullySoldOut = true;
                } else {
                    await client.query(
                        `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                        [newQty, product.id, userId]
                    );
                }

                totalQty += qty;
                totalRevenue += price * qty;
                totalProfit += profit;
                affectedLocalIds.add(Number(product.local_id));

                if (!firstProductName) {
                    firstProductName = product.name;
                    firstLocalId = product.local_id;
                    firstImageUrl = product.image_url || null;
                }

                soldLines.push(
                    `   • 📏 ${telegramEscape(product.size || 'Standart')}: ${qty} dona × ${formatSum(price)} so'm`
                );
            }

            const remainingDebt = Math.max(0, totalRevenue - parsedPaidNow);

            // User & Telegram
            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b>\n";
            try {
                const localIds = Array.from(affectedLocalIds);
                if (localIds.length) {
                    const remainingResult = await client.query(
                        `
                        SELECT local_id, size, quantity
                        FROM public.products
                        WHERE user_id = $1 AND local_id = ANY($2::int[])
                        ORDER BY local_id, size
                        `,
                        [userId, localIds]
                    );

                    if (remainingResult.rows.length === 0) {
                        remainingStockInfo += "❌ Mahsulot omborda qolmagan";
                    } else {
                        remainingStockInfo += remainingResult.rows
                            .map(r => `• ${telegramEscape(r.size || 'Standart')}: ${r.quantity} ta`)
                            .join('\n');
                    }
                }
            } catch (e) {
                remainingStockInfo += "❌ Ma'lumot topilmadi";
            }

            let sellMessage =
                `🛒 <b>NASIYAGA SOTILDI (#${firstLocalId})</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(firstProductName)}\n` +
                `👤 <b>Mijoz:</b> ${telegramEscape(cleanCustomerName)}\n` +
                `📞 <b>Telefon:</b> ${telegramEscape(cleanCustomerPhone)}\n` +
                `📏 <b>Razmerlar:</b>\n${soldLines.join('\n')}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📊 <b>Jami sotilgan:</b> ${totalQty} dona\n` +
                `💰 <b>Jami summa:</b> ${formatSum(totalRevenue)} so'm\n` +
                `💵 <b>Hozir to'langan:</b> ${formatSum(parsedPaidNow)} so'm\n` +
                `📉 <b>Qolgan qarz (mijoz):</b> ${formatSum(remainingDebt)} so'm\n` +
                `${totalProfit >= 0 ? '📈' : '📉'} <b>${totalProfit >= 0 ? 'Foyda' : 'Ziyon'}:</b> ${formatSum(Math.abs(totalProfit))} so'm\n` +
                remainingStockInfo +
                `\n━━━━━━━━━━━━━━━━━━━━\n` +
                (anyFullySoldOut ? `🗑 Ba'zi razmerlar ombordan chiqarildi\n` : '') +
                `✅ Nasiya savdosi amalga oshdi!`;

            sellMessage += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, sellMessage, firstImageUrl);

            await client.query('COMMIT');

            return res.json({
                message: "Tovar nasiyaga muvaffaqiyatli sotildi!",
                totalQty,
                totalRevenue,
                totalProfit,
                paid_now: parsedPaidNow,
                remaining_customer_debt: remainingDebt
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('Nasiyaga sotishda xatolik:', err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// SOTUVLAR RO'YXATI
// ====================================================

app.get(
    '/api/sales',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT
                    id,
                    product_id,
                    title,
                    quantity,
                    cost_price,
                    selling_price,
                    profit,
                    local_id,
                    category,
                    color,
                    size,
                    returned,
                    sold_at,
                    customer_name,
                    customer_phone,
                    is_credit,
                    paid_now,
                    image_url
                FROM public.sales
                WHERE user_id = $1
                ORDER BY sold_at DESC
                LIMIT 200
                `,
                [req.user.userId]
            );

            res.json({
                sales: result.rows
            });
        } catch (err) {
            console.error('Sotuvlarni olish xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        }
    }
);


// ====================================================
// TOVARNI O'CHIRISH / KAMAYTIRISH
// ====================================================

app.post(
    '/api/dashboard/delete-product',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        let items = Array.isArray(req.body.items) ? req.body.items : null;

        if (!items) {
            const {
                product_id,
                remove_all,
                quantity_to_remove
            } = req.body;
            items = [{
                product_id,
                remove_all,
                quantity_to_remove
            }];
        }

        if (!items.length) {
            return res.status(400).json({
                message: "Kamida bitta tovar tanlanishi shart!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const removedLines = [];
            let totalRemoved = 0;
            let anyFullyRemoved = false;
            let firstLocalId = null;
            let firstProductName = null;
            let firstCategory = null;
            let firstColor = null;
            let firstImageUrl = null;
            const affectedLocalIds = new Set();
            const results = [];

            for (const item of items) {
                const productId = Number(item.product_id);

                if (!Number.isInteger(productId) || productId <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Tovar ID noto'g'ri!" });
                }

                const removeAll = item.remove_all === true || item.remove_all === 'true';
                let quantityToRemove = 0;

                if (!removeAll) {
                    quantityToRemove = parseInt(item.quantity_to_remove, 10);
                    if (!Number.isInteger(quantityToRemove) || quantityToRemove <= 0) {
                        await client.query('ROLLBACK');
                        return res.status(400).json({ message: "Olib tashlanadigan son noto'g'ri!" });
                    }
                }

                const result = await client.query(
                    `SELECT * FROM public.products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                    [productId, userId]
                );

                if (!result.rows.length) {
                    await client.query('ROLLBACK');
                    return res.status(404).json({ message: `Tovar topilmadi! (ID: ${productId})` });
                }

                const product = result.rows[0];
                const currentQty = Number(product.quantity) || 0;
                const removeQty = removeAll ? currentQty : quantityToRemove;

                if (removeQty <= 0) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ message: "Olib tashlanadigan son noto'g'ri!" });
                }
                if (removeQty > currentQty) {
                    await client.query('ROLLBACK');
                    return res.status(400).json({
                        message: `Omborda buncha tovar yo'q! (${product.name}: ${currentQty} dona)`
                    });
                }

                const newQty = currentQty - removeQty;
                const fullyRemoved = newQty === 0;

                if (fullyRemoved) {
                    // Arxivga saqlash (7 kun ichida qaytarish uchun)
                    await client.query(
                        `
                        INSERT INTO public.deleted_products
                        (
                            original_id, user_id, local_id, category, name, cost_price,
                            color, size, quantity, payment_type, supplier, paid_amount,
                            supplier_phone, selling_price, qr_token, image_url, deleted_at
                        )
                        VALUES
                        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,NOW())
                        `,
                        [
                            product.id,
                            userId,
                            product.local_id,
                            product.category,
                            product.name,
                            product.cost_price,
                            product.color,
                            product.size,
                            product.quantity,
                            product.payment_type || 'cash',
                            product.supplier,
                            product.paid_amount || 0,
                            product.supplier_phone,
                            product.selling_price,
                            product.qr_token,
                            product.image_url || null
                        ]
                    );
                    await client.query(
                        `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                        [product.id, userId]
                    );
                    anyFullyRemoved = true;
                } else {
                    await client.query(
                        `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                        [newQty, product.id, userId]
                    );
                }

                affectedLocalIds.add(Number(product.local_id));

                if (firstLocalId === null) {
                    firstLocalId = product.local_id;
                    firstProductName = product.name;
                    firstCategory = product.category;
                    firstColor = product.color;
                    firstImageUrl = product.image_url || null;
                }

                totalRemoved += removeQty;

                removedLines.push(
                    `   • 📏 ${telegramEscape(product.size || "Standart")}: ${removeQty} dona olib tashlandi` +
                    (fullyRemoved ? ` (🗑 butunlay tugadi)` : ` (qoldiq: ${newQty} ta)`)
                );

                results.push({
                    product_id: product.id,
                    local_id: product.local_id,
                    size: product.size,
                    removedQty: removeQty,
                    remainingQuantity: newQty,
                    productFullyRemoved: fullyRemoved
                });
            }

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let remainingStockInfo = "\n📏 <b>Omborda qolgan razmerlar:</b>\n";
            try {
                const localIds = Array.from(affectedLocalIds);
                if (localIds.length) {
                    const remainingResult = await client.query(
                        `
                        SELECT local_id, size, quantity
                        FROM public.products
                        WHERE user_id = $1 AND local_id = ANY($2::int[])
                        ORDER BY local_id, size
                        `,
                        [userId, localIds]
                    );

                    if (remainingResult.rows.length === 0) {
                        remainingStockInfo += "❌ Mahsulot omborda qolmagan";
                    } else {
                        remainingStockInfo += remainingResult.rows
                            .map(r => `• ${telegramEscape(r.size || 'Standart')}: ${r.quantity} ta`)
                            .join('\n');
                    }
                }
            } catch (e) {
                remainingStockInfo += "❌ Ma'lumot topilmadi";
            }

            const titleLine = items.length > 1
                ? `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI — ${items.length} TA RAZMER (#${firstLocalId})</b>`
                : `📉 <b>MAHSULOT KAMAYTIRILDI / O'CHIRILDI (#${firstLocalId})</b>`;

            let deleteMessage =
                `${titleLine}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(firstProductName)}\n` +
                `🗂 <b>Kategoriyasi:</b> ${telegramEscape(firstCategory || "Yo'q")}\n` +
                `🎨 <b>Rangi:</b> ${telegramEscape(firstColor || "Yo'q")}\n` +
                `📏 <b>Razmerlar bo'yicha olib tashlandi:</b>\n` +
                `${removedLines.join('\n')}\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `➖ <b>Jami olib tashlandi:</b> ${totalRemoved} dona` +
                remainingStockInfo +
                `\n━━━━━━━━━━━━━━━━━━━━` +
                (anyFullyRemoved ? `\n🗑 Ba'zi razmerlar ombordan butunlay chiqarildi` : '');

            deleteMessage += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, deleteMessage, firstImageUrl);

            await client.query('COMMIT');

            return res.json({
                message: "Amal(lar) muvaffaqiyatli bajarildi",
                totalRemoved,
                productFullySoldOut: anyFullyRemoved,
                results
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("O'chirishda xatolik:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// RASXOD QO'SHISH
// ====================================================

app.post(
    '/api/dashboard/expenses',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const { title, amount, expense_type } = req.body;

        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        const parsedAmount = Number(amount);

        if (!cleanTitle) {
            return res.status(400).json({
                message: "Rasxod nomi kiritilishi shart!"
            });
        }

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                message: "Rasxod summasi noto'g'ri!"
            });
        }

        const type = ['daily', 'monthly', 'yearly'].includes(expense_type)
            ? expense_type
            : 'daily';

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                INSERT INTO public.expenses
                (user_id, title, amount, expense_type)
                VALUES ($1, $2, $3, $4)
                RETURNING *
                `,
                [userId, cleanTitle, parsedAmount, type]
            );

            const expense = result.rows[0];

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            const expenseDate = expense.created_at
                ? new Date(expense.created_at).toLocaleDateString('uz-UZ')
                : new Date().toLocaleDateString('uz-UZ');

            let expenseMessage =
                `💸 <b>YANGI RASXOD QO'SHILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(expense.title)}\n` +
                `💰 <b>Summasi:</b> ${formatSum(expense.amount)} so'm\n` +
                `📂 <b>Turi:</b> ${telegramEscape(type)}\n` +
                `📅 <b>Sanasi:</b> ${telegramEscape(expenseDate)}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            expenseMessage += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, expenseMessage);

            await client.query('COMMIT');

            return res.status(201).json({
                message: "Rasxod muvaffaqiyatli qo'shildi",
                expense
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("Rasxod qo'shishda xatolik:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// RASXODLAR RO'YXATI
// ====================================================

app.get(
    '/api/expenses',
    authenticateToken,
    async (req, res) => {
        try {
            const result = await pool.query(
                `
                SELECT id, title, amount, expense_type, created_at
                FROM public.expenses
                WHERE user_id = $1
                ORDER BY created_at DESC
                LIMIT 200
                `,
                [req.user.userId]
            );

            res.json({
                expenses: result.rows
            });
        } catch (err) {
            console.error('Rasxodlarni olish xatosi:', err);
            res.status(500).json({
                message: 'Serverda xatolik yuz berdi!'
            });
        }
    }
);

// ====================================================
// RASXODNI TAHRIRLASH
// ====================================================

app.put(
    '/api/expenses/:id',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const expenseId = Number(req.params.id);

        if (!Number.isInteger(expenseId) || expenseId <= 0) {
            return res.status(400).json({
                message: "Rasxod ID noto'g'ri!"
            });
        }

        const { title, amount, expense_type } = req.body || {};

        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        const parsedAmount = Number(amount);

        if (!cleanTitle) {
            return res.status(400).json({
                message: "Rasxod nomi kiritilishi shart!"
            });
        }

        if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
            return res.status(400).json({
                message: "Rasxod summasi noto'g'ri!"
            });
        }

        const type = ['daily', 'monthly', 'yearly'].includes(expense_type)
            ? expense_type
            : 'daily';

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const existing = await client.query(
                `SELECT * FROM public.expenses WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                [expenseId, userId]
            );

            if (!existing.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Rasxod topilmadi!"
                });
            }

            const expense = existing.rows[0];

            if (daysSince(expense.created_at) > EXPENSE_EDIT_WINDOW_DAYS) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: `Bu rasxod qo'shilganiga 1 oydan ko'p vaqt o'tgan, tahrirlab bo'lmaydi!`
                });
            }

            const updated = await client.query(
                `
                UPDATE public.expenses
                SET title = $1, amount = $2, expense_type = $3
                WHERE id = $4
                RETURNING *
                `,
                [cleanTitle, parsedAmount, type, expenseId]
            );

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `✏️ <b>RASXOD TAHRIRLANDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(cleanTitle)}\n` +
                `💰 <b>Summasi:</b> ${formatSum(parsedAmount)} so'm\n` +
                `📂 <b>Turi:</b> ${telegramEscape(type)}\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            message += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, message);

            await client.query('COMMIT');

            return res.json({
                message: "Rasxod muvaffaqiyatli tahrirlandi!",
                expense: updated.rows[0]
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("Rasxodni tahrirlashda xatolik:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// RASXODNI O'CHIRISH
// ====================================================

app.delete(
    '/api/expenses/:id',
    authenticateToken,
    async (req, res) => {
        const userId = req.user.userId;
        const expenseId = Number(req.params.id);

        if (!Number.isInteger(expenseId) || expenseId <= 0) {
            return res.status(400).json({
                message: "Rasxod ID noto'g'ri!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const existing = await client.query(
                `SELECT * FROM public.expenses WHERE id = $1 AND user_id = $2 FOR UPDATE`,
                [expenseId, userId]
            );

            if (!existing.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "Rasxod topilmadi!"
                });
            }

            const expense = existing.rows[0];

            if (daysSince(expense.created_at) > EXPENSE_EDIT_WINDOW_DAYS) {
                await client.query('ROLLBACK');
                return res.status(403).json({
                    message: `Bu rasxod qo'shilganiga 1 oydan ko'p vaqt o'tgan, o'chirib bo'lmaydi!`
                });
            }

            await client.query(
                `DELETE FROM public.expenses WHERE id = $1`,
                [expenseId]
            );

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [userId]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `🗑️ <b>RASXOD O'CHIRILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📝 <b>Tavsifi:</b> ${telegramEscape(expense.title)}\n` +
                `💰 <b>Summasi:</b> ${formatSum(expense.amount)} so'm\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            message += await getTodayReport(client, userId);

            await queueTelegramNotification(client, siteLogin, message);

            await client.query('COMMIT');

            return res.json({
                message: "Rasxod muvaffaqiyatli o'chirildi!"
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("Rasxodni o'chirishda xatolik:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QR MA'LUMOT
// ====================================================

app.get(
    '/api/qr/:token',
    async (req, res) => {
        const token = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!token) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        try {
            const result = await pool.query(
                `
                SELECT
                    id, user_id, local_id, name, category, color, size,
                    cost_price, quantity, qr_token, qr_created_at, created_at
                FROM public.products
                WHERE qr_token = $1
                LIMIT 1
                `,
                [token]
            );

            if (!result.rows.length) {
                return res.status(404).json({
                    message: "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product = result.rows[0];
            const quantity = Number(product.quantity) || 0;

            if (quantity <= 0) {
                return res.status(410).json({
                    message: "Bu tovar omborda qolmagan!"
                });
            }

            return res.json({
                product
            });
        } catch (err) {
            console.error("QR ma'lumot xatosi:", err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        }
    }
);

// ====================================================
// QR SOTUV
// ====================================================

app.post(
    '/api/qr/:token/sell',
    async (req, res) => {
        const token = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!token) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        const sellingPrice = Number(req.body?.selling_price);

        if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
            return res.status(400).json({
                message: "Sotuv narxini to'g'ri kiriting!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT *
                FROM public.products
                WHERE qr_token = $1
                LIMIT 1
                FOR UPDATE
                `,
                [token]
            );

            if (!result.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product = result.rows[0];
            const quantity = Number(product.quantity) || 0;

            if (quantity <= 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: "Bu tovar omborda qolmagan!"
                });
            }

            const qty = 1;
            const cost = Number(product.cost_price) || 0;
            const totalAmount = sellingPrice * qty;
            const profit = (sellingPrice - cost) * qty;
            const newQty = quantity - qty;

            await client.query(
                `
INSERT INTO public.sales
(
    user_id,
    product_id,
    title,
    quantity,
    cost_price,
    selling_price,
    profit,
    local_id,
    category,
    color,
    size,
    image_url
)
VALUES
(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12
)
                `,
                [
                    product.user_id,
                    product.id,
                    product.name,
                    qty,
                    cost,
                    sellingPrice,
                    profit,
                    product.local_id,
                    product.category,
                    product.color,
                    product.size,
                    product.image_url || null
                ]
            );

            if (newQty === 0) {
                await client.query(
                    `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                    [product.id, product.user_id]
                );
            } else {
                await client.query(
                    `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                    [newQty, product.id, product.user_id]
                );
            }

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [product.user_id]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `💰 <b>QR ORQALI SOTUV</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n` +
                `🔢 <b>Soni:</b> 1 dona\n` +
                `💵 <b>Sotuv:</b> ${formatSum(sellingPrice)} so'm\n` +
                `💳 <b>Tannarx:</b> ${formatSum(cost)} so'm\n` +
                `${profit >= 0 ? '📈' : '📉'} <b>${profit >= 0 ? 'Foyda' : 'Ziyon'}:</b> ${formatSum(Math.abs(profit))} so'm\n` +
                `📦 <b>Qoldiq:</b> ${newQty} dona`;

            if (newQty === 0) {
                message += `\n🗑 <b>Bu razmer ombordan tugadi.</b>`;
            }

            message += await getTodayReport(client, product.user_id);

            await queueTelegramNotification(client, siteLogin, message, product.image_url || null);

            await client.query('COMMIT');

            return res.json({
                success: true,
                product: {
                    id: product.id,
                    local_id: product.local_id,
                    name: product.name,
                    size: product.size,
                    color: product.color,
                    cost_price: cost
                },
                selling_price: sellingPrice,
                quantity: qty,
                total_amount: totalAmount,
                profit,
                remaining_quantity: newQty
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('QR sotuv xatosi:', err);
            return res.status(500).json({
                message: "QR orqali sotishda server xatosi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QR O'CHIRISH
// ====================================================

app.post(
    '/api/qr/:token/delete',
    async (req, res) => {
        const token = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!token) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT *
                FROM public.products
                WHERE qr_token = $1
                LIMIT 1
                FOR UPDATE
                `,
                [token]
            );

            if (!result.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product = result.rows[0];

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [product.user_id]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            await client.query(
                `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                [product.id, product.user_id]
            );

            const messageBase =
                `🗑️ <b>QR ORQALI TOVAR O'CHIRILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n` +
                `🎨 <b>Rang:</b> ${telegramEscape(product.color || "Ko'rsatilmagan")}\n` +
                `🗂 <b>Kategoriya:</b> ${telegramEscape(product.category || "Ko'rsatilmagan")}\n` +
                `💰 <b>Tannarx:</b> ${formatSum(product.cost_price)} so'm\n` +
                `🔢 <b>Ombordagi miqdor:</b> ${Number(product.quantity) || 0} dona\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `🗑️ Tovar ombordan chiqarildi.`;

            const message = messageBase + await getTodayReport(client, product.user_id);

            await queueTelegramNotification(client, siteLogin, message, product.image_url || null);

            await client.query('COMMIT');

            return res.json({
                success: true,
                message: "Tovar ombordan o'chirildi!"
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error("QR o'chirish xatosi:", err);
            return res.status(500).json({
                message: "QR orqali o'chirishda server xatosi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// QR NASIYAGA SOTISH
// ====================================================

app.post(
    '/api/qr/:token/sell-credit',
    async (req, res) => {
        const token = typeof req.params.token === 'string'
            ? req.params.token.trim()
            : '';

        if (!token) {
            return res.status(400).json({
                message: "QR token kiritilmagan!"
            });
        }

        const sellingPrice = Number(req.body?.selling_price);
        const cleanCustomerName = typeof req.body?.customer_name === 'string'
            ? req.body.customer_name.trim()
            : '';
        const cleanCustomerPhone = typeof req.body?.customer_phone === 'string'
            ? req.body.customer_phone.trim()
            : '';
        const parsedPaidNow = Number(req.body?.paid_now) || 0;

        if (!Number.isFinite(sellingPrice) || sellingPrice < 0) {
            return res.status(400).json({
                message: "Sotuv narxini to'g'ri kiriting!"
            });
        }
        if (!cleanCustomerName) {
            return res.status(400).json({
                message: "Mijoz ismini kiriting!"
            });
        }
        if (!cleanCustomerPhone) {
            return res.status(400).json({
                message: "Mijoz telefonini kiriting!"
            });
        }

        const client = await pool.connect();

        try {
            await client.query('BEGIN');

            const result = await client.query(
                `
                SELECT *
                FROM public.products
                WHERE qr_token = $1
                LIMIT 1
                FOR UPDATE
                `,
                [token]
            );

            if (!result.rows.length) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    message: "QR kodi eskirgan yoki tovar topilmadi!"
                });
            }

            const product = result.rows[0];
            const quantity = Number(product.quantity) || 0;

            if (quantity <= 0) {
                await client.query('ROLLBACK');
                return res.status(409).json({
                    message: "Bu tovar omborda qolmagan!"
                });
            }

            const qty = 1;
            const cost = Number(product.cost_price) || 0;
            const totalAmount = sellingPrice * qty;
            const profit = (sellingPrice - cost) * qty;
            const newQty = quantity - qty;
            const remainingDebt = Math.max(0, totalAmount - parsedPaidNow);

            // Sales — nasiya belgisi bilan
            await client.query(
                `
                INSERT INTO public.sales
                (
                    user_id, product_id, title, quantity, cost_price, selling_price, profit,
                    local_id, category, color, size, image_url,
                    customer_name, customer_phone, is_credit, paid_now
                )
                VALUES
                ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15)
                `,
                [
                    product.user_id,
                    product.id,
                    product.name,
                    qty,
                    cost,
                    sellingPrice,
                    profit,
                    product.local_id,
                    product.category,
                    product.color,
                    product.size,
                    product.image_url || null,
                    cleanCustomerName,
                    cleanCustomerPhone,
                    parsedPaidNow
                ]
            );

            if (newQty === 0) {
                await client.query(
                    `DELETE FROM public.products WHERE id = $1 AND user_id = $2`,
                    [product.id, product.user_id]
                );
            } else {
                await client.query(
                    `UPDATE public.products SET quantity = $1 WHERE id = $2 AND user_id = $3`,
                    [newQty, product.id, product.user_id]
                );
            }

            const userResult = await client.query(
                `SELECT site_login FROM public.users WHERE id = $1`,
                [product.user_id]
            );
            const siteLogin = userResult.rows[0]?.site_login || null;

            let message =
                `🛒 <b>QR ORQALI NASIYAGA SOTILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Tovar:</b> ${telegramEscape(product.name)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(product.size || 'Standart')}\n` +
                `👤 <b>Mijoz:</b> ${telegramEscape(cleanCustomerName)}\n` +
                `📞 <b>Telefon:</b> ${telegramEscape(cleanCustomerPhone)}\n` +
                `🔢 <b>Soni:</b> 1 dona\n` +
                `💵 <b>Jami summa:</b> ${formatSum(sellingPrice)} so'm\n` +
                `💰 <b>Hozir to'langan:</b> ${formatSum(parsedPaidNow)} so'm\n` +
                `📉 <b>Qolgan qarz (mijoz):</b> ${formatSum(remainingDebt)} so'm\n` +
                `💳 <b>Tannarx:</b> ${formatSum(cost)} so'm\n` +
                `${profit >= 0 ? '📈' : '📉'} <b>${profit >= 0 ? 'Foyda' : 'Ziyon'}:</b> ${formatSum(Math.abs(profit))} so'm\n` +
                `📦 <b>Qoldiq:</b> ${newQty} dona`;

            if (newQty === 0) {
                message += `\n🗑 <b>Bu razmer ombordan tugadi.</b>`;
            }

            message += await getTodayReport(client, product.user_id);

            await queueTelegramNotification(client, siteLogin, message, product.image_url || null);

            await client.query('COMMIT');

            return res.json({
                success: true,
                product: {
                    id: product.id,
                    local_id: product.local_id,
                    name: product.name,
                    size: product.size,
                    color: product.color,
                    cost_price: cost
                },
                selling_price: sellingPrice,
                quantity: qty,
                total_amount: totalAmount,
                profit,
                remaining_quantity: newQty,
                customer_name: cleanCustomerName,
                customer_phone: cleanCustomerPhone,
                paid_now: parsedPaidNow,
                remaining_customer_debt: remainingDebt
            });
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch (e) { }
            console.error('QR nasiyaga sotish xatosi:', err);
            return res.status(500).json({
                message: "QR orqali nasiyaga sotishda server xatosi!"
            });
        } finally {
            client.release();
        }
    }
);

// ====================================================
// BOT PROFITS
// ====================================================

app.get(
    '/api/bot/profits/:site_login',
    async (req, res) => {
        const siteLogin = typeof req.params.site_login === 'string'
            ? req.params.site_login.trim()
            : '';

        if (!siteLogin) {
            return res.status(400).json({
                message: "site_login kiritilmagan!"
            });
        }

        try {
            const userResult = await pool.query(
                `SELECT id FROM public.users WHERE site_login = $1 LIMIT 1`,
                [siteLogin]
            );

            if (!userResult.rows.length) {
                return res.status(404).json({
                    message: "Foydalanuvchi topilmadi!"
                });
            }

            const userId = userResult.rows[0].id;

            const getPeriodProfit = async (salesFilter, expenseFilter) => {
                const sales = await pool.query(
                    `
                    SELECT COALESCE(SUM(profit), 0) AS gross_profit
                    FROM public.sales
                    WHERE user_id = $1 AND returned = false AND ${salesFilter}
                    `,
                    [userId]
                );

                const expenses = await pool.query(
                    `
                    SELECT COALESCE(SUM(amount), 0) AS expense
                    FROM public.expenses
                    WHERE user_id = $1 AND ${expenseFilter}
                    `,
                    [userId]
                );

                return (
                    Number(sales.rows[0].gross_profit || 0) -
                    Number(expenses.rows[0].expense || 0)
                );
            };

            const dailyProfit = await getPeriodProfit(
                `sold_at::date = CURRENT_DATE`,
                `created_at::date = CURRENT_DATE`
            );

            const weeklyProfit = await getPeriodProfit(
                `sold_at >= date_trunc('week', CURRENT_DATE)`,
                `created_at >= date_trunc('week', CURRENT_DATE)`
            );

            const monthlyProfit = await getPeriodProfit(
                `date_trunc('month', sold_at) = date_trunc('month', CURRENT_DATE)`,
                `date_trunc('month', created_at) = date_trunc('month', CURRENT_DATE)`
            );

            const yearlyProfit = await getPeriodProfit(
                `date_trunc('year', sold_at) = date_trunc('year', CURRENT_DATE)`,
                `date_trunc('year', created_at) = date_trunc('year', CURRENT_DATE)`
            );

            return res.json({
                success: true,
                site_login: siteLogin,
                dailyProfit,
                weeklyProfit,
                monthlyProfit,
                yearlyProfit
            });
        } catch (err) {
            console.error('Bot profits xatosi:', err);
            return res.status(500).json({
                message: "Serverda xatolik yuz berdi!"
            });
        }
    }
);

// ====================================================
// MIJOZ QARZLARI RO'YXATI
// ====================================================
app.get('/api/customer-debts', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;

        const result = await pool.query(`
            SELECT
                customer_name,
                customer_phone,
                SUM(quantity * selling_price) AS total_amount,
                SUM(COALESCE(paid_now, 0)) AS total_paid,
                GREATEST(SUM(quantity * selling_price) - SUM(COALESCE(paid_now, 0)), 0) AS debt,
                COUNT(*) AS sales_count,
                json_agg(
                    json_build_object(
                        'id', id,
                        'title', title,
                        'size', size,
                        'quantity', quantity,
                        'selling_price', selling_price,
                        'paid_now', paid_now,
                        'sold_at', sold_at
                    ) ORDER BY sold_at DESC
                ) AS sales
            FROM public.sales
            WHERE user_id = $1
              AND is_credit = true
              AND returned = false
              AND customer_name IS NOT NULL
            GROUP BY customer_name, customer_phone
            HAVING SUM(quantity * selling_price) - SUM(COALESCE(paid_now, 0)) > 0
            ORDER BY debt DESC
        `, [userId]);

        res.json({ debts: result.rows });
    } catch (err) {
        console.error('Mijoz qarzlarini olish xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    }
});

// ====================================================
// MIJOZ QARZINI TO'LASH
// ====================================================
app.post('/api/customer-debts/pay', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const { customer_name, customer_phone, amount } = req.body || {};

    const cleanName = typeof customer_name === 'string' ? customer_name.trim() : '';
    const cleanPhone = typeof customer_phone === 'string' ? customer_phone.trim() : '';
    const parsedAmount = Number(amount);

    if (!cleanName) {
        return res.status(400).json({ message: "Mijoz ismi ko'rsatilmagan!" });
    }
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0) {
        return res.status(400).json({ message: "To'lov summasi noto'g'ri!" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const salesRes = await client.query(`
            SELECT id, quantity, selling_price, COALESCE(paid_now, 0) AS paid_now
            FROM public.sales
            WHERE user_id = $1
              AND is_credit = true
              AND returned = false
              AND customer_name = $2
              AND (customer_phone = $3 OR ($3 = '' AND (customer_phone IS NULL OR customer_phone = '')))
            ORDER BY sold_at ASC
            FOR UPDATE
        `, [userId, cleanName, cleanPhone]);

        if (salesRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "Bu mijozga tegishli qarz topilmadi!" });
        }

        let remainingPay = parsedAmount;
        let totalPaidNow = 0;

        for (const sale of salesRes.rows) {
            if (remainingPay <= 0) break;

            const saleTotal = Number(sale.quantity) * Number(sale.selling_price);
            const alreadyPaid = Number(sale.paid_now) || 0;
            const saleDebt = saleTotal - alreadyPaid;

            if (saleDebt <= 0) continue;

            const payForThis = Math.min(remainingPay, saleDebt);
            const newPaid = alreadyPaid + payForThis;

            await client.query(
                `UPDATE public.sales SET paid_now = $1 WHERE id = $2`,
                [newPaid, sale.id]
            );

            remainingPay -= payForThis;
            totalPaidNow += payForThis;
        }

        if (totalPaidNow <= 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ message: "To'lov amalga oshmadi!" });
        }

        const remainRes = await client.query(`
            SELECT COALESCE(SUM(quantity * selling_price - COALESCE(paid_now, 0)), 0) AS remaining
            FROM public.sales
            WHERE user_id = $1
              AND is_credit = true
              AND returned = false
              AND customer_name = $2
        `, [userId, cleanName]);

        const remainingDebt = Number(remainRes.rows[0].remaining || 0);

        const userRes = await client.query(`SELECT site_login FROM public.users WHERE id = $1`, [userId]);
        const siteLogin = userRes.rows[0]?.site_login || null;

        if (siteLogin) {
            let msg =
                `💰 <b>MIJOZ QARZI TO'LANDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `👤 <b>Mijoz:</b> ${telegramEscape(cleanName)}\n` +
                (cleanPhone ? `📞 <b>Telefon:</b> ${telegramEscape(cleanPhone)}\n` : '') +
                `💵 <b>To'langan:</b> ${formatSum(totalPaidNow)} so'm\n` +
                `📉 <b>Qolgan qarz:</b> ${formatSum(remainingDebt)} so'm\n` +
                `━━━━━━━━━━━━━━━━━━━━`;

            msg += await getTodayReport(client, userId);
            await queueTelegramNotification(client, siteLogin, msg);
        }

        await client.query('COMMIT');

        res.json({
            message: `${formatSum(totalPaidNow)} so'm muvaffaqiyatli qabul qilindi! Qolgan qarz: ${formatSum(remainingDebt)} so'm`,
            paid: totalPaidNow,
            remaining_debt: remainingDebt
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { }
        console.error('Mijoz qarzini to\'lashda xatolik:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    } finally {
        client.release();
    }
});

// ====================================================
// O'CHIRILGAN TOVARLAR (7 kun ichida qaytarish)
// ====================================================
app.get('/api/products/deleted', authenticateToken, async (req, res) => {
    try {
        const userId = req.user.userId;
        const result = await pool.query(
            `
            SELECT *
            FROM public.deleted_products
            WHERE user_id = $1
              AND deleted_at >= NOW() - ($2 || ' days')::interval
            ORDER BY deleted_at DESC
            `,
            [userId, String(DELETED_RESTORE_WINDOW_DAYS)]
        );
        res.json({ products: result.rows });
    } catch (err) {
        console.error("O'chirilgan tovarlarni olish xatosi:", err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi!' });
    }
});

// ====================================================
// TOVARNI OMBORGA QAYTARISH
// ====================================================
app.post('/api/products/restore', authenticateToken, async (req, res) => {
    const userId = req.user.userId;
    const deletedId = Number(req.body?.deleted_id);

    if (!Number.isInteger(deletedId) || deletedId <= 0) {
        return res.status(400).json({ message: "ID noto'g'ri!" });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const delRes = await client.query(
            `SELECT * FROM public.deleted_products WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [deletedId, userId]
        );

        if (!delRes.rows.length) {
            await client.query('ROLLBACK');
            return res.status(404).json({ message: "O'chirilgan tovar topilmadi!" });
        }

        const row = delRes.rows[0];

        if (daysSince(row.deleted_at) > DELETED_RESTORE_WINDOW_DAYS) {
            await client.query('ROLLBACK');
            return res.status(403).json({
                message: `Bu tovar ${DELETED_RESTORE_WINDOW_DAYS} kundan ko'p vaqt oldin o'chirilgan, qaytarib bo'lmaydi!`
            });
        }

        const insertRes = await client.query(
            `
            INSERT INTO public.products
            (
                user_id, local_id, category, name, cost_price, color, size,
                quantity, qr_token, qr_created_at, payment_type, supplier,
                paid_amount, supplier_phone, selling_price, image_url
            )
            VALUES
            ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),$10,$11,$12,$13,$14,$15)
            RETURNING *
            `,
            [
                userId,
                row.local_id,
                row.category,
                row.name,
                row.cost_price,
                row.color,
                row.size,
                row.quantity,
                row.qr_token || randomUUID(),
                row.payment_type || 'cash',
                row.supplier,
                row.paid_amount || 0,
                row.supplier_phone,
                row.selling_price,
                row.image_url || null
            ]
        );

        await client.query(
            `DELETE FROM public.deleted_products WHERE id = $1`,
            [deletedId]
        );

        const userRes = await client.query(
            `SELECT site_login FROM public.users WHERE id = $1`,
            [userId]
        );
        const siteLogin = userRes.rows[0]?.site_login || null;

        if (siteLogin) {
            let msg =
                `↩️ <b>O'CHIRILGAN TOVAR QAYTARILDI</b>\n` +
                `━━━━━━━━━━━━━━━━━━━━\n` +
                `📦 <b>Nomi:</b> ${telegramEscape(row.name)}\n` +
                `📏 <b>Razmer:</b> ${telegramEscape(row.size || 'Standart')}\n` +
                `🔢 <b>Soni:</b> ${row.quantity} dona\n` +
                `━━━━━━━━━━━━━━━━━━━━`;
            msg += await getTodayReport(client, userId);
            await queueTelegramNotification(client, siteLogin, msg, row.image_url || null);
        }

        await client.query('COMMIT');

        res.json({
            message: "Tovar muvaffaqiyatli omborga qaytarildi!",
            product: insertRes.rows[0]
        });
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (e) { }
        console.error("Tovarni qaytarishda xatolik:", err);
        res.status(500).json({ message: "Serverda xatolik yuz berdi!" });
    } finally {
        client.release();
    }
});

// ====================================================
// 404
// ====================================================

app.use((req, res) => {
    return res.status(404).json({
        message: "Bunday yo'nalish topilmadi"
    });
});

// ====================================================
// GLOBAL ERROR HANDLER
// ====================================================

app.use((err, req, res, next) => {
    console.error('Global server xatosi:', err);
    if (res.headersSent) {
        return next(err);
    }
    return res.status(500).json({
        message: "Serverda kutilmagan xatolik yuz berdi!"
    });
});

// ====================================================
// SERVER ISHGA TUSHIRISH
// ====================================================

if (process.env.VERCEL) {
    module.exports = app;
} else {
    const PORT = Number(process.env.PORT) || 5000;
    let server;

    let lastDailyReportDate = null;
    let lastMonthlyReportMonth = null;

    const checkAndSendScheduledReports = async () => {
        try {
            const now = new Date();
            const tashkentOffset = 5 * 60;
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            const tashkent = new Date(utc + (tashkentOffset * 60000));

            const hours = tashkent.getHours();
            const minutes = tashkent.getMinutes();
            const dateStr = tashkent.toISOString().slice(0, 10);
            const monthStr = dateStr.slice(0, 7);

            if (hours === 23 && minutes === 59) {
                if (lastDailyReportDate !== dateStr) {
                    lastDailyReportDate = dateStr;
                    console.log('[CRON] Kunlik hisobot yuborilmoqda...', dateStr);
                    await sendReportToAllUsers('daily');
                }
            }

            const tomorrow = new Date(tashkent);
            tomorrow.setDate(tomorrow.getDate() + 1);
            const isLastDayOfMonth = tomorrow.getDate() === 1;

            if (isLastDayOfMonth && hours === 23 && minutes === 59) {
                if (lastMonthlyReportMonth !== monthStr) {
                    lastMonthlyReportMonth = monthStr;
                    console.log('[CRON] Oylik hisobot yuborilmoqda...', monthStr);
                    await sendReportToAllUsers('monthly');
                }
            }
        } catch (err) {
            console.error('[CRON] Xatolik:', err);
        }
    };

    setInterval(checkAndSendScheduledReports, 30 * 1000);

    const startServer = async () => {
        try {
            await ensureTablesOnce();
        } catch (err) {
            console.error(
                '❌ ensureTables() umumiy xatosi (server baribir ishga tushadi):',
                err
            );
        }

        server = app.listen(PORT, () => {
            console.log(
                `Backend Server ${PORT}-portda ishga tushdi 🚀`
            );
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.error(`❌ ${PORT}-port allaqachon band!`);
                process.exit(1);
            }
            console.error('❌ Server ishga tushishida xatolik:', err);
            process.exit(1);
        });
    };

    startServer();

    const shutdown = async (signal) => {
        console.log(`\n${signal} signali olindi. Server yopilmoqda...`);
        try {
            if (server) {
                await new Promise((resolve) => {
                    server.close(resolve);
                });
            }
            await pool.end();
            console.log('Server va PostgreSQL connection pool yopildi.');
            process.exit(0);
        } catch (err) {
            console.error('Serverni yopishda xatolik:', err);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
}
