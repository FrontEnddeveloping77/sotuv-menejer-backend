const express = require('express');
const router = express.Router();

// Auth va obuna tekshiruvi (kerak bo'lsa o'zingizning auth middlewaredan foydalanasiz)
const checkAuthAndSubscription = (req, res, next) => {
    next();
};

// TELEGRAM BOT BILAN BOG'LANISH VA BILDIRISHNOMA YUBORISH FUNKSIYASI
const sendTelegramNotification = async (req, message) => {
    try {
        const bot = req.app.get('bot'); // app.js / server.js faylingizda bot app.set('bot', bot) qilingan deb hisoblaymiz
        const TELEGRAM_GROUP_ID = process.env.TELEGRAM_GROUP_ID || process.env.GROUP_CHAT_ID;

        if (bot && TELEGRAM_GROUP_ID) {
            await bot.sendMessage(TELEGRAM_GROUP_ID, message, { parse_mode: 'HTML' });
        }
    } catch (err) {
        console.error('Telegramga xabar yuborishda xatolik:', err.message);
    }
};

// Pul summasini formatlash (Masalan: 120 000 so'm)
const formatSum = (sum) => {
    return Number(sum || 0).toLocaleString('uz-UZ');
};

// 1. STATISTIKA
router.get('/stats', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const productsRes = await pool.query(
            'SELECT COUNT(*) as total_products, COALESCE(SUM(quantity), 0) as total_stock FROM products WHERE user_id = $1',
            [userId]
        );

        const totalSalesRes = await pool.query(
            `SELECT 
        COALESCE(SUM(COALESCE(sell_quantity, quantity, 0)), 0) as total_sold, 
        COALESCE(SUM(COALESCE(total_amount, selling_price * COALESCE(sell_quantity, quantity, 1), sale_price * COALESCE(sell_quantity, quantity, 1), 0)), 0) as total_revenue, 
        COALESCE(SUM((COALESCE(selling_price, sale_price, 0) - COALESCE(cost_price, 0)) * COALESCE(sell_quantity, quantity, 1)), 0) as total_profit 
       FROM sales WHERE user_id = $1`,
            [userId]
        );

        const dailySalesRes = await pool.query(
            `SELECT 
        COALESCE(SUM(COALESCE(sell_quantity, quantity, 0)), 0) as daily_sold, 
        COALESCE(SUM(COALESCE(total_amount, selling_price * COALESCE(sell_quantity, quantity, 1), sale_price * COALESCE(sell_quantity, quantity, 1), 0)), 0) as daily_revenue, 
        COALESCE(SUM((COALESCE(selling_price, sale_price, 0) - COALESCE(cost_price, 0)) * COALESCE(sell_quantity, quantity, 1)), 0) as daily_profit 
       FROM sales WHERE user_id = $1 AND DATE(created_at) = CURRENT_DATE`,
            [userId]
        );

        const monthlySalesRes = await pool.query(
            `SELECT 
        COALESCE(SUM(COALESCE(sell_quantity, quantity, 0)), 0) as monthly_sold, 
        COALESCE(SUM(COALESCE(total_amount, selling_price * COALESCE(sell_quantity, quantity, 1), sale_price * COALESCE(sell_quantity, quantity, 1), 0)), 0) as monthly_revenue, 
        COALESCE(SUM((COALESCE(selling_price, sale_price, 0) - COALESCE(cost_price, 0)) * COALESCE(sell_quantity, quantity, 1)), 0) as monthly_profit 
       FROM sales WHERE user_id = $1 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`,
            [userId]
        );

        const yearlySalesRes = await pool.query(
            `SELECT 
        COALESCE(SUM(COALESCE(sell_quantity, quantity, 0)), 0) as yearly_sold, 
        COALESCE(SUM(COALESCE(total_amount, selling_price * COALESCE(sell_quantity, quantity, 1), sale_price * COALESCE(sell_quantity, quantity, 1), 0)), 0) as yearly_revenue, 
        COALESCE(SUM((COALESCE(selling_price, sale_price, 0) - COALESCE(cost_price, 0)) * COALESCE(sell_quantity, quantity, 1)), 0) as yearly_profit 
       FROM sales WHERE user_id = $1 AND DATE_TRUNC('year', created_at) = DATE_TRUNC('year', CURRENT_DATE)`,
            [userId]
        );

        const dailyExpenseRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as daily_exp FROM expenses WHERE user_id = $1 AND DATE(created_at) = CURRENT_DATE AND expense_type = 'daily'`,
            [userId]
        );

        const monthlyExpenseRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as monthly_exp FROM expenses WHERE user_id = $1 AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE) AND expense_type IN ('daily', 'monthly')`,
            [userId]
        );

        const yearlyExpenseRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as yearly_exp FROM expenses WHERE user_id = $1 AND DATE_TRUNC('year', created_at) = DATE_TRUNC('year', CURRENT_DATE)`,
            [userId]
        );

        const totalExpenseRes = await pool.query(
            `SELECT COALESCE(SUM(amount), 0) as total_exp FROM expenses WHERE user_id = $1`,
            [userId]
        );

        const userRes = await pool.query('SELECT site_login FROM users WHERE id = $1', [userId]);

        const grossDailyProfit = parseFloat(dailySalesRes.rows[0].daily_profit) || 0;
        const grossMonthlyProfit = parseFloat(monthlySalesRes.rows[0].monthly_profit) || 0;
        const grossYearlyProfit = parseFloat(yearlySalesRes.rows[0].yearly_profit) || 0;
        const grossTotalProfit = parseFloat(totalSalesRes.rows[0].total_profit) || 0;

        const dailyExp = parseFloat(dailyExpenseRes.rows[0].daily_exp) || 0;
        const monthlyExp = parseFloat(monthlyExpenseRes.rows[0].monthly_exp) || 0;
        const yearlyExp = parseFloat(yearlyExpenseRes.rows[0].yearly_exp) || 0;
        const totalExp = parseFloat(totalExpenseRes.rows[0].total_exp) || 0;

        res.json({
            storeName: userRes.rows[0]?.site_login || 'Mening Do‘konim',
            totalProducts: parseInt(productsRes.rows[0].total_products) || 0,
            totalStock: parseInt(productsRes.rows[0].total_stock) || 0,

            totalSold: parseInt(totalSalesRes.rows[0].total_sold) || 0,
            totalRevenue: parseFloat(totalSalesRes.rows[0].total_revenue) || 0,
            totalProfit: grossTotalProfit - totalExp,
            totalExpense: totalExp,

            dailySold: parseInt(dailySalesRes.rows[0].daily_sold) || 0,
            dailyRevenue: parseFloat(dailySalesRes.rows[0].daily_revenue) || 0,
            dailyProfit: grossDailyProfit - dailyExp,
            dailyExpense: dailyExp,

            monthlySold: parseInt(monthlySalesRes.rows[0].monthly_sold) || 0,
            monthlyRevenue: parseFloat(monthlySalesRes.rows[0].monthly_revenue) || 0,
            monthlyProfit: grossMonthlyProfit - monthlyExp,
            monthlyExpense: monthlyExp,

            yearlySold: parseInt(yearlySalesRes.rows[0].yearly_sold) || 0,
            yearlyRevenue: parseFloat(yearlySalesRes.rows[0].yearly_revenue) || 0,
            yearlyProfit: grossYearlyProfit - yearlyExp,
            yearlyExpense: yearlyExp,
        });
    } catch (err) {
        console.error('Stats xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 2. TOVARLAR RO'YXATI
router.get('/products', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const result = await pool.query(
            'SELECT id, title, category, cost_price, color, quantity, description FROM products WHERE user_id = $1 ORDER BY id DESC',
            [userId]
        );

        res.json(result.rows);
    } catch (err) {
        console.error('Products get xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 3. TOVAR QO'SHISH (TELEGRAM GURUH BILDIRISHNOMASI BILAN)
router.post('/products', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : req.body.userId;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const { title, name, category, cost_price, color, quantity, description } = req.body;

        const productTitle = (title || name || '').trim();
        if (!productTitle || cost_price === undefined || cost_price === null || cost_price === '') {
            return res.status(400).json({ message: 'Tovar nomi va kelgan narxi kiritilishi shart!' });
        }

        const parsedCostPrice = parseFloat(cost_price) || 0;
        const prodCategory = (category || 'Umumiy').trim();
        const prodColor = color ? String(color).trim() : 'Ko‘rsatilmagan';
        const qtyToAdd = parseInt(quantity) || 1;

        const existingProductRes = await pool.query(
            `SELECT id, quantity FROM products 
             WHERE user_id = $1 
               AND LOWER(title) = LOWER($2) 
               AND LOWER(category) = LOWER($3) 
               AND COALESCE(LOWER(color), '') = COALESCE(LOWER($4), '') 
               AND cost_price = $5`,
            [userId, productTitle, prodCategory, color ? prodColor : null, parsedCostPrice]
        );

        let finalProductId;
        let newStockQuantity;

        if (existingProductRes.rows.length > 0) {
            finalProductId = existingProductRes.rows[0].id;
            const updatedProduct = await pool.query(
                `UPDATE products 
                 SET quantity = quantity + $1 
                 WHERE id = $2 AND user_id = $3 
                 RETURNING *`,
                [qtyToAdd, finalProductId, userId]
            );
            newStockQuantity = updatedProduct.rows[0].quantity;
        } else {
            const insertQuery = `
                INSERT INTO products (user_id, title, category, cost_price, price, color, quantity, description)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *;
            `;

            const values = [
                userId,
                productTitle,
                prodCategory,
                parsedCostPrice,
                parsedCostPrice,
                color ? prodColor : null,
                qtyToAdd,
                description || '',
            ];

            const newProduct = await pool.query(insertQuery, values);
            finalProductId = newProduct.rows[0].id;
            newStockQuantity = newProduct.rows[0].quantity;
        }

        // TELEGRAM GURUHGA XABAR
        const telegramMessage = `
➕ <b>Yangi Tovar Qo‘shildi!</b>

🆔 <b>ID:</b> #${finalProductId}
📦 <b>Nomi:</b> ${productTitle}
📁 <b>Kategoriya:</b> ${prodCategory}
🎨 <b>Rangi:</b> ${prodColor}
💵 <b>Kelgan Narxi:</b> ${formatSum(parsedCostPrice)} so'm
🔢 <b>Qo‘shilgan Soni:</b> ${qtyToAdd} ta
📊 <b>Umumiy Qoldiq:</b> ${newStockQuantity} ta
        `;
        sendTelegramNotification(req, telegramMessage);

        return res.status(200).json({
            success: true,
            message: 'Tovar muvaffaqiyatli saqlandi',
            product_id: finalProductId,
        });
    } catch (err) {
        console.error('Tovar qo‘shishda xatolik:', err.message);
        res.status(500).json({ message: `Serverda xatolik: ${err.message}` });
    }
});

router.post('/sell', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const { product_id, sell_quantity, selling_price, quantity, sellPrice } = req.body;
        const targetProductId = parseInt(product_id);
        const qty = parseInt(sell_quantity || quantity) || 1;
        const sPrice = parseFloat(selling_price || sellPrice) || 0;
        const totalAmount = qty * sPrice;

        // 1. SELECT so'roviga 'size' qo'shildi
        const productRes = await pool.query(
            'SELECT id, title, category, color, size, quantity, cost_price FROM products WHERE id = $1 AND user_id = $2',
            [targetProductId, userId]
        );

        if (productRes.rows.length === 0) {
            return res.status(404).json({ message: 'Tovar topilmadi!' });
        }

        const product = productRes.rows[0];

        if (parseInt(product.quantity) < qty) {
            return res.status(400).json({ message: `Omborda yetarli tovar yo‘q! Qoldiq: ${product.quantity} ta` });
        }

        await pool.query(
            `INSERT INTO sales (user_id, product_id, quantity, sell_quantity, sale_price, selling_price, total_amount, cost_price, created_at) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [
                userId,
                targetProductId,
                qty,
                qty,
                sPrice,
                sPrice,
                totalAmount,
                parseFloat(product.cost_price) || 0,
            ]
        );

        const updatedProdRes = await pool.query(
            'UPDATE products SET quantity = quantity - $1 WHERE id = $2 AND user_id = $3 RETURNING quantity',
            [qty, targetProductId, userId]
        );

        const remainingStock = updatedProdRes.rows[0]?.quantity ?? (product.quantity - qty);
        const profit = (sPrice - parseFloat(product.cost_price || 0)) * qty;

        // 2. TELEGRAM GURUHGA XABAR (Razmer qismi qo'shildi)
        const telegramMessage = `
🛒 <b>Tovar Sotildi!</b>

🆔 <b>ID:</b> #${product.id}
📦 <b>Nomi:</b> ${product.title}
🎨 <b>Rangi:</b> ${product.color || '-'}
📏 <b>Razmeri:</b> ${product.size || '-'}
🔢 <b>Sotilgan Soni:</b> ${qty} ta
💰 <b>Sotish Narxi:</b> ${formatSum(sPrice)} so'm
💵 <b>Jami Summa:</b> ${formatSum(totalAmount)} so'm
📈 <b>Sof Foyda:</b> ${formatSum(profit)} so'm
📊 <b>Ombordagi Qoldiq:</b> ${remainingStock} ta
        `;
        sendTelegramNotification(req, telegramMessage);

        res.json({ success: true, message: 'Sotuv amalga oshirildi' });
    } catch (err) {
        console.error('Sotuv xatosi:', err.message);
        res.status(500).json({ message: `Sotuvda xatolik: ${err.message}` });
    }
});

// 5. TOVARNI OLIB TASHLASH / O'CHIRISH (TELEGRAM GURUH BILDIRISHNOMASI BILAN)
router.post('/delete-product', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const { product_id, remove_all, quantity_to_remove, quantityToRemove } = req.body;
        const targetProductId = parseInt(product_id);

        if (!targetProductId) {
            return res.status(400).json({ message: 'Tovar tanlanmagan!' });
        }

        // 1. SELECT so'roviga 'color' va 'size' qo'shildi
        const productRes = await pool.query(
            'SELECT id, title, color, size, quantity FROM products WHERE id = $1 AND user_id = $2',
            [targetProductId, userId]
        );

        if (productRes.rows.length === 0) {
            return res.status(404).json({ message: 'Tovar topilmadi!' });
        }

        const product = productRes.rows[0];
        const currentQty = parseInt(product.quantity) || 0;
        const qtyToRemove = parseInt(quantity_to_remove || quantityToRemove) || 0;

        await pool.query('UPDATE sales SET product_id = NULL WHERE product_id = $1 AND user_id = $2', [targetProductId, userId]);

        let telegramMessage = '';

        if (remove_all || qtyToRemove >= currentQty) {
            await pool.query('DELETE FROM products WHERE id = $1 AND user_id = $2', [targetProductId, userId]);

            // 2. To'liq o'chirilganda Telegram xabariga razmer qo'shildi
            telegramMessage = `
🗑️ <b>Tovar To‘liq O‘chirildi!</b>

🆔 <b>ID:</b> #${product.id}
📦 <b>Nomi:</b> ${product.title}
🎨 <b>Rangi:</b> ${product.color || '-'}
📏 <b>Razmeri:</b> ${product.size || '-'}
❗ Tovar ombordan to‘liq olib tashlandi.
            `;
            sendTelegramNotification(req, telegramMessage);
            return res.json({ success: true, message: "Tovar ombordan to'liq o'chirildi!" });
        } else {
            const updatedProdRes = await pool.query(
                'UPDATE products SET quantity = quantity - $1 WHERE id = $2 AND user_id = $3 RETURNING quantity',
                [qtyToRemove, targetProductId, userId]
            );
            const remaining = updatedProdRes.rows[0]?.quantity ?? (currentQty - qtyToRemove);

            // 3. Soni kamaytirilganda Telegram xabariga razmer qo'shildi
            telegramMessage = `
📉 <b>Tovar Soni Kamaytirildi!</b>

🆔 <b>ID:</b> #${product.id}
📦 <b>Nomi:</b> ${product.title}
🎨 <b>Rangi:</b> ${product.color || '-'}
📏 <b>Razmeri:</b> ${product.size || '-'}
➖ <b>Olib tashlandi:</b> ${qtyToRemove} ta
📊 <b>Qolgan Qoldiq:</b> ${remaining} ta
            `;
            sendTelegramNotification(req, telegramMessage);

            return res.json({ success: true, message: `${qtyToRemove} ta tovar ombordan olib tashlandi!` });
        }
    } catch (err) {
        console.error('Tovarni o‘chirishda xatolik:', err.message);
        res.status(500).json({ message: `Xatolik: ${err.message}` });
    }
});

// 6. RASXOD QO'SHISH (TELEGRAM GURUH BILDIRISHNOMASI BILAN)
router.post('/expenses', checkAuthAndSubscription, async (req, res) => {
    try {
        const pool = req.app.get('pool');
        const userId = req.user ? req.user.userId : null;

        if (!userId) return res.status(401).json({ message: 'Foydalanuvchi aniqlanmadi!' });

        const { title, amount, expense_type } = req.body;

        if (!title || !amount || !expense_type) {
            return res.status(400).json({ message: 'Barcha maydonlarni to‘ldiring!' });
        }

        await pool.query(
            `INSERT INTO expenses (user_id, title, amount, expense_type, created_at)
             VALUES ($1, $2, $3, $4, NOW())`,
            [userId, title, parseFloat(amount), expense_type]
        );

        // TELEGRAM GURUHGA XABAR
        const telegramMessage = `
💸 <b>Yangi Rasxod Yozildi!</b>

📝 <b>Sababi:</b> ${title}
💰 <b>Summa:</b> ${formatSum(amount)} so'm
📅 <b>Turi:</b> ${expense_type === 'daily' ? 'Kunlik' : 'Oylik'}
        `;
        sendTelegramNotification(req, telegramMessage);

        res.status(201).json({ success: true, message: 'Rasxod muvaffaqiyatli saqlandi' });
    } catch (err) {
        console.error('Rasxod saqlash xatosi:', err.message);
        res.status(500).json({ message: `Serverda xatolik: ${err.message}` });
    }
});

module.exports = router;