const express = require('express');
const router = express.Router();
const axios = require('axios');

const BOT_TOKEN = process.env.BOT_TOKEN;

const sendTelegramNotification = async (chatId, saleData) => {
    if (!chatId || !BOT_TOKEN) return;

    const message =
        `🛒 **YANGI SOTUV BAJARILDI!**

📦 **Tovar:** ${saleData.title}
📏 **Razmer:** ${saleData.size || "Ko'rsatilmagan"}
🔢 **Soni:** ${saleData.quantity} dona
💰 **Sotuv narxi:** ${Number(saleData.sale_price).toLocaleString('uz-UZ')} so'm
💵 **Jami summa:** ${Number(saleData.total_amount).toLocaleString('uz-UZ')} so'm
📈 **Foyda:** ${Number(saleData.profit).toLocaleString('uz-UZ')} so'm
⏰ **Vaqt:** ${new Date().toLocaleString('uz-UZ')}`;

    try {
        await axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'Markdown'
        });
    } catch (err) {
        console.error('Telegramga xabar yuborishda xatolik:', err?.response?.data || err.message);
    }
};

// 1. Do'kon statistikasini olish
router.get('/stats', async (req, res) => {
    const pool = req.app.get('pool');
    const userId = req.user.userId;

    try {
        let storeResult = await pool.query('SELECT id, name, telegram_group_id FROM public.stores WHERE user_id = $1', [userId]);

        if (storeResult.rows.length === 0) {
            storeResult = await pool.query(
                'INSERT INTO public.stores (user_id, name) VALUES ($1, $2) RETURNING id, name, telegram_group_id',
                [userId, 'Mening Do‘konim']
            );
        }

        const storeId = storeResult.rows[0].id;

        const productsStats = await pool.query(
            'SELECT COUNT(id) as total_products, COALESCE(SUM(quantity), 0) as total_stock FROM public.products WHERE store_id = $1',
            [storeId]
        );

        const salesStats = await pool.query(
            'SELECT COALESCE(SUM(quantity), 0) as total_sold, COALESCE(SUM(total_amount), 0) as total_revenue, COALESCE(SUM(profit), 0) as total_profit FROM public.sales WHERE store_id = $1',
            [storeId]
        );

        res.json({
            storeName: storeResult.rows[0].name,
            telegramGroupId: storeResult.rows[0].telegram_group_id,
            totalProducts: parseInt(productsStats.rows[0].total_products),
            totalStock: parseInt(productsStats.rows[0].total_stock),
            totalSold: parseInt(salesStats.rows[0].total_sold),
            totalRevenue: parseFloat(salesStats.rows[0].total_revenue),
            totalProfit: parseFloat(salesStats.rows[0].total_profit)
        });
    } catch (err) {
        console.error('Statistika xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 2. Yangi tovar qo'shish (Razmer bilan birga)
router.post('/products', async (req, res) => {
    const pool = req.app.get('pool');
    const userId = req.user.userId;
    const { title, name, category, color, size, cost_price, selling_price, quantity } = req.body;

    const productTitle = title || name;

    try {
        const store = await pool.query('SELECT id FROM public.stores WHERE user_id = $1', [userId]);
        if (store.rows.length === 0) return res.status(404).json({ message: 'Do‘kon topilmadi!' });

        const storeId = store.rows[0].id;

        // INSERT so'roviga size qo'shildi
        const newProduct = await pool.query(
            'INSERT INTO public.products (store_id, title, category, color, size, cost_price, selling_price, quantity) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
            [storeId, productTitle, category || null, color || null, size || null, cost_price || 0, selling_price || 0, quantity || 1]
        );

        const countRes = await pool.query(
            'SELECT COUNT(id) as total_count FROM public.products WHERE store_id = $1',
            [storeId]
        );

        const localId = parseInt(countRes.rows[0].total_count);

        res.json({
            success: true,
            product: {
                ...newProduct.rows[0],
                local_id: localId
            },
            local_id: localId,
            message: `Tovar saqlandi! Razmer: ${size || "Yo'q"}, ID: #${localId}`
        });
    } catch (err) {
        console.error('Tovar qo‘shish xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 3. Barcha tovarlar ro'yxatini olish (ORDER BY id ASC - o'sish tartibida)
router.get('/products', async (req, res) => {
    const pool = req.app.get('pool');
    const userId = req.user.userId;

    try {
        const store = await pool.query('SELECT id FROM public.stores WHERE user_id = $1', [userId]);
        if (store.rows.length === 0) return res.json([]);

        // ORDER BY id ASC qilindi: Eng yangi qo'shilgan tovar ro'yxatning O'XIRIGA tushadi
        const products = await pool.query(
            'SELECT * FROM public.products WHERE store_id = $1 ORDER BY id ASC',
            [store.rows[0].id]
        );

        res.json(products.rows);
    } catch (err) {
        console.error('Tovarlarni olish xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 4. Sotuv kiritish
router.post('/sell', async (req, res) => {
    const pool = req.app.get('pool');
    const userId = req.user.userId;
    const { product_id, sell_quantity, selling_price } = req.body;

    try {
        const store = await pool.query('SELECT id, telegram_group_id FROM public.stores WHERE user_id = $1', [userId]);
        if (store.rows.length === 0) return res.status(404).json({ message: 'Do‘kon topilmadi!' });

        const storeId = store.rows[0].id;
        const telegramGroupId = store.rows[0].telegram_group_id;

        const productRes = await pool.query('SELECT * FROM public.products WHERE id = $1 AND store_id = $2', [product_id, storeId]);
        if (productRes.rows.length === 0) return res.status(404).json({ message: 'Tovar topilmadi!' });

        const product = productRes.rows[0];

        if (product.quantity < sell_quantity) {
            return res.status(400).json({ message: 'Omborda yetarli tovar yo‘q!' });
        }

        // Kiritilgan custom sotish narxi yoki mahsulotning standart sotuv narxi ishlatiladi
        const actualSellPrice = Number(selling_price) || Number(product.selling_price);
        const totalAmount = actualSellPrice * sell_quantity;
        const profit = (actualSellPrice - product.cost_price) * sell_quantity;

        await pool.query(
            'INSERT INTO public.sales (store_id, product_id, quantity, sale_price, cost_price, total_amount, profit) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [storeId, product_id, sell_quantity, actualSellPrice, product.cost_price, totalAmount, profit]
        );

        await pool.query(
            'UPDATE public.products SET quantity = quantity - $1 WHERE id = $2',
            [sell_quantity, product_id]
        );

        if (telegramGroupId) {
            await sendTelegramNotification(telegramGroupId, {
                title: product.title,
                quantity: sell_quantity,
                sale_price: actualSellPrice,
                total_amount: totalAmount,
                profit: profit,
                size: product.size
            });
        }

        res.json({ success: true, message: 'Sotuv amalga oshirildi!' });
    } catch (err) {
        console.error('Sotuv xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

module.exports = router;