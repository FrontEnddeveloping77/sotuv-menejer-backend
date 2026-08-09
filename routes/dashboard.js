const express = require('express');
const router = express.Router();

// 1. Do'kon statistikasini olish
router.get('/stats', async (req, res) => {
    const pool = req.app.get('pool');
    const userId = req.user.userId;

    try {
        let storeResult = await pool.query('SELECT id, name FROM public.stores WHERE user_id = $1', [userId]);

        if (storeResult.rows.length === 0) {
            storeResult = await pool.query(
                'INSERT INTO public.stores (user_id, name) VALUES ($1, $2) RETURNING id, name',
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

// 2. Yangi tovar qo'shish
router.post('/products', async (req, res) => {
    const pool = req.app.get('pool');
    const userId = req.user.userId;
    const { title, cost_price, selling_price, quantity } = req.body;

    try {
        const store = await pool.query('SELECT id FROM public.stores WHERE user_id = $1', [userId]);
        if (store.rows.length === 0) return res.status(404).json({ message: 'Do‘kon topilmadi!' });

        const newProduct = await pool.query(
            'INSERT INTO public.products (store_id, title, cost_price, selling_price, quantity) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [store.rows[0].id, title, cost_price, selling_price, quantity]
        );

        res.json({ success: true, product: newProduct.rows[0] });
    } catch (err) {
        console.error('Tovar qo‘shish xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

// 3. Barcha tovarlar ro'yxatini olish
router.get('/products', async (req, res) => {
    const pool = req.app.get('pool');
    const userId = req.user.userId;

    try {
        const store = await pool.query('SELECT id FROM public.stores WHERE user_id = $1', [userId]);
        if (store.rows.length === 0) return res.json([]);

        const products = await pool.query(
            'SELECT * FROM public.products WHERE store_id = $1 ORDER BY id DESC',
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
    const { product_id, sell_quantity } = req.body;

    try {
        const store = await pool.query('SELECT id FROM public.stores WHERE user_id = $1', [userId]);
        const storeId = store.rows[0].id;

        const productRes = await pool.query('SELECT * FROM public.products WHERE id = $1 AND store_id = $2', [product_id, storeId]);
        if (productRes.rows.length === 0) return res.status(404).json({ message: 'Tovar topilmadi!' });

        const product = productRes.rows[0];

        if (product.quantity < sell_quantity) {
            return res.status(400).json({ message: 'Omborda yetarli tovar yo‘q!' });
        }

        const totalAmount = product.selling_price * sell_quantity;
        const profit = (product.selling_price - product.cost_price) * sell_quantity;

        await pool.query(
            'INSERT INTO public.sales (store_id, product_id, quantity, sale_price, cost_price, total_amount, profit) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [storeId, product_id, sell_quantity, product.selling_price, product.cost_price, totalAmount, profit]
        );

        await pool.query(
            'UPDATE public.products SET quantity = quantity - $1 WHERE id = $2',
            [sell_quantity, product_id]
        );

        res.json({ success: true, message: 'Sotuv amalga oshirildi!' });
    } catch (err) {
        console.error('Sotuv xatosi:', err);
        res.status(500).json({ message: 'Serverda xatolik yuz berdi' });
    }
});

module.exports = router;