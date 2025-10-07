// --- 1. INISIALISASI & KONFIGURASI ---
require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
// const puppeteer = require('puppeteer'); // Dependensi Puppeteer dihapus
const mysql = require('mysql2/promise');

// Konfigurasi dari file .env
const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

if (!TOKEN) {
    console.error("Error: Pastikan TELEGRAM_BOT_TOKEN sudah diatur di file .env");
    process.exit(1);
}

// Inisialisasi Bot dan Express
const bot = new TelegramBot(TOKEN, { polling: true });
const app = express();

// Konfigurasi koneksi database
const dbConfig = {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};
const pool = mysql.createPool(dbConfig);
const userRequestTimestamps = {};
const userState = {}; // Menyimpan state percakapan sementara

// --- 2. FUNGSI HELPER ---

function formatRupiah(number) {
    return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        minimumFractionDigits: 0
    }).format(number);
}

function formatDate(date) {
    return new Date(date).toLocaleDateString('id-ID', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

async function getStoreInfo(storeId) {
    if (!storeId) return null;
    const connection = await pool.getConnection();
    try {
        const [stores] = await connection.execute('SELECT * FROM stores WHERE id = ?', [storeId]);
        return stores.length > 0 ? stores[0] : null;
    } finally {
        connection.release();
    }
}

// --- 3. FUNGSI DATABASE TRANSAKSI ---

async function saveTransaction(invoiceData, storeId, userId) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();

        const totalAmount = invoiceData.items.reduce((acc, item) => acc + item.totalPriceConsumer, 0);

        const [transactionResult] = await connection.execute(
            'INSERT INTO transactions (invoice_number, store_id, user_id, cashier_name, payment_method, total_amount, transaction_date) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [invoiceData.invoiceNumber, storeId, userId, invoiceData.cashierName, invoiceData.paymentMethod, totalAmount, new Date()]
        );
        const transactionId = transactionResult.insertId;

        for (const item of invoiceData.items) {
            // Harga per unit konsumen dihitung dari total bayar dibagi jumlah
            const priceConsumerPerUnit = item.totalPriceConsumer / item.qty;
            await connection.execute(
                'INSERT INTO transaction_items (transaction_id, product_name, quantity, unit, price_vp, price_consumer) VALUES (?, ?, ?, ?, ?, ?)',
                [transactionId, item.name, item.qty, item.unit, item.priceVp, priceConsumerPerUnit]
            );
        }
        await connection.commit();
        console.log(`✅ Transaksi ${invoiceData.invoiceNumber} berhasil disimpan.`);
        return { transactionId, totalAmount };
    } catch (error) {
        await connection.rollback();
        console.error('❌ Gagal menyimpan transaksi:', error);
        throw error;
    } finally {
        connection.release();
    }
}

async function updateTransaction(invoiceNumber, newData, userId) {
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [transactions] = await connection.execute('SELECT id FROM transactions WHERE invoice_number = ?', [invoiceNumber]);
        if (transactions.length === 0) throw new Error('Transaksi tidak ditemukan.');
        const transactionId = transactions[0].id;
        
        const newTotalAmount = newData.items.reduce((acc, item) => acc + item.totalPriceConsumer, 0);

        await connection.execute('UPDATE transactions SET cashier_name = ?, payment_method = ?, total_amount = ? WHERE id = ?', [newData.cashier_name, newData.payment_method, newTotalAmount, transactionId]);
        await connection.execute('DELETE FROM transaction_items WHERE transaction_id = ?', [transactionId]);

        for (const item of newData.items) {
             const priceConsumerPerUnit = item.totalPriceConsumer / item.qty;
            await connection.execute(
                'INSERT INTO transaction_items (transaction_id, product_name, quantity, unit, price_vp, price_consumer) VALUES (?, ?, ?, ?, ?, ?)',
                [transactionId, item.name, item.qty, item.unit, item.priceVp, priceConsumerPerUnit]
            );
        }
        await connection.commit();
        return true;
    } catch (error) {
        await connection.rollback();
        console.error(`❌ Gagal update transaksi ${invoiceNumber}:`, error);
        throw error;
    } finally {
        connection.release();
    }
}

async function findTransactionByInvoice(invoiceNumber, storeId) {
    const connection = await pool.getConnection();
    try {
        let sql = 'SELECT t.*, s.name as store_name FROM transactions t JOIN stores s ON t.store_id = s.id WHERE t.invoice_number = ?';
        let params = [invoiceNumber];
        if (storeId) {
            sql += ' AND t.store_id = ?';
            params.push(storeId);
        }
        const [transactions] = await connection.execute(sql, params);
        if (transactions.length === 0) return null;

        const transaction = transactions[0];
        const [items] = await connection.execute('SELECT * FROM transaction_items WHERE transaction_id = ?', [transaction.id]);
        
        // Menyiapkan data agar konsisten dengan state
        transaction.items = items.map(item => ({
            name: item.product_name,
            qty: item.quantity,
            unit: item.unit,
            priceVp: item.price_vp,
            totalPriceConsumer: item.quantity * item.price_consumer
        }));
        return transaction;
    } finally {
        connection.release();
    }
}

// --- 4. FUNGSI LAPORAN (DENGAN SELISIH) ---

async function generateDailyReport(date = new Date(), storeId) {
    const connection = await pool.getConnection();
    try {
        const aDay = date.toISOString().split('T')[0];
        
        // 1. Ambil Total Pendapatan (Sales) & Jumlah Transaksi. Query ini sudah benar.
        const [rows] = await connection.execute('SELECT SUM(total_amount) as totalSales, COUNT(id) as totalTransactions FROM transactions WHERE DATE(transaction_date) = ? AND store_id = ?', [aDay, storeId]);
        const totalSales = parseFloat(rows[0].totalSales || 0);
        const totalTransactions = rows[0].totalTransactions || 0;

        // --- BAGIAN YANG DIPERBAIKI ---
        // GANTI dengan query baru yang hanya mengambil total modal (biaya).
        const [costData] = await connection.execute(`
            SELECT SUM(ti.price_vp * ti.quantity) as totalCost 
            FROM transaction_items ti 
            JOIN transactions t ON ti.transaction_id = t.id 
            WHERE DATE(t.transaction_date) = ? AND t.store_id = ?`, 
            [aDay, storeId]
        );
        const totalCost = parseFloat(costData[0].totalCost || 0);
        
        // HITUNG selisih/margin di dalam kode menggunakan data yang akurat.
        const totalMargin = totalSales - totalCost;
        // --- AKHIR BAGIAN YANG DIPERBAIKI ---

        const [items] = await connection.execute(`SELECT product_name, unit, SUM(quantity) as totalQty, SUM(quantity * price_consumer) as totalRevenue FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id WHERE DATE(t.transaction_date) = ? AND t.store_id = ? GROUP BY product_name, unit ORDER BY totalQty DESC LIMIT 5`, [aDay, storeId]);
        const [paymentMethods] = await connection.execute(`SELECT payment_method, COUNT(*) as count, SUM(total_amount) as total FROM transactions WHERE DATE(transaction_date) = ? AND store_id = ? GROUP BY payment_method`, [aDay, storeId]);
        const storeInfo = await getStoreInfo(storeId);
        const storeName = storeInfo ? storeInfo.name : 'Toko Tidak Dikenal';

        // Tampilan pesan tetap sama, namun sekarang menggunakan variabel `totalMargin` yang sudah benar.
        let reportMessage = `📊 *LAPORAN PENJUALAN HARIAN*\n🏪 *${storeName}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 ${date.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n💰 *Total Pendapatan:* ${formatRupiah(totalSales)}\n🧾 *Jumlah Transaksi:* ${totalTransactions} transaksi\n📈 *Total Selisih (Profit/Rugi):* ${formatRupiah(totalMargin)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
        
        if (items.length > 0) {
            reportMessage += `\n🔥 *PRODUK TERLARIS:*\n`;
            items.forEach((item, index) => {
                reportMessage += `${index + 1}. ${item.product_name}\n   Terjual: ${item.totalQty} ${item.unit} | ${formatRupiah(item.totalRevenue)}\n`;
            });
        } else {
            reportMessage += `\n_Tidak ada produk yang terjual hari ini._\n`;
        }
        if (paymentMethods.length > 0) {
            reportMessage += `\n💳 *METODE PEMBAYARAN:*\n`;
            paymentMethods.forEach(pm => {
                reportMessage += `• ${pm.payment_method}: ${pm.count}x (${formatRupiah(pm.total)})\n`;
            });
        }
        reportMessage += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return reportMessage;
    } catch (error) {
        console.error("❌ Gagal membuat laporan:", error);
        return "⚠️ Gagal membuat laporan.";
    } finally {
        connection.release();
    }
}

async function generateRegionalReport(date = new Date(), regionId) {
    const connection = await pool.getConnection();
    try {
        const aDay = date.toISOString().split('T')[0];
        const [regionInfo] = await connection.execute('SELECT name FROM regions WHERE id = ?', [regionId]);
        const regionName = regionInfo.length > 0 ? regionInfo[0].name : "N/A";
        
        const [totalData] = await connection.execute(`SELECT SUM(t.total_amount) as totalSales, COUNT(t.id) as totalTransactions FROM transactions t JOIN stores s ON t.store_id = s.id WHERE DATE(t.transaction_date) = ? AND s.region_id = ?`, [aDay, regionId]);
        
        const [marginData] = await connection.execute(`SELECT SUM((ti.price_consumer * ti.quantity) - (ti.price_vp * ti.quantity)) as totalMargin FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id JOIN stores s ON t.store_id = s.id WHERE DATE(t.transaction_date) = ? AND s.region_id = ?`, [aDay, regionId]);
        
        // --- QUERY YANG DIMODIFIKASI ---
        const [storeData] = await connection.execute(`
            SELECT 
                s.name, 
                COUNT(DISTINCT t.id) as transactions, 
                SUM(t.total_amount) as sales,
                SUM((ti.price_consumer * ti.quantity) - (ti.price_vp * ti.quantity)) as margin
            FROM stores s 
            LEFT JOIN transactions t ON s.id = t.store_id AND DATE(t.transaction_date) = ?
            LEFT JOIN transaction_items ti ON t.id = ti.transaction_id
            WHERE s.region_id = ? AND s.status = 'active' 
            GROUP BY s.id, s.name 
            ORDER BY sales DESC`, 
            [aDay, regionId]
        );

        const totalSales = parseFloat(totalData[0].totalSales || 0);
        const totalTransactions = totalData[0].totalTransactions || 0;
        const totalMargin = parseFloat(marginData[0].totalMargin || 0);

        let reportMessage = `🌍 *LAPORAN REGIONAL HARIAN*\n📍 *${regionName}*\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n📅 ${date.toLocaleDateString('id-ID', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n💰 *Total Pendapatan:* ${formatRupiah(totalSales)}\n🧾 *Total Transaksi:* ${totalTransactions}\n📈 *Total Selisih Regional:* ${formatRupiah(totalMargin)}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n📍 *BREAKDOWN PER TOKO:*\n`;
        
        if (storeData.length > 0 && storeData.some(s => s.sales > 0)) {
            // --- BAGIAN TAMPILAN YANG DIMODIFIKASI ---
            storeData.forEach((store, index) => {
                const sales = parseFloat(store.sales || 0);
                const margin = parseFloat(store.margin || 0);
                const percentage = totalSales > 0 ? ((sales / totalSales) * 100).toFixed(1) : 0;
                reportMessage += `\n${index + 1}. *${store.name}*\n   Pendapatan: ${formatRupiah(sales)} (${percentage}%)\n   Transaksi: ${store.transactions || 0}x\n   Selisih: *${formatRupiah(margin)}*\n`;
            });
        } else {
            reportMessage += `\n_Tidak ada penjualan di regional ini hari ini._\n`;
        }
        
        reportMessage += `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
        return reportMessage;
    } catch (error) {
        console.error("❌ Gagal membuat laporan regional:", error);
        return "⚠️ Gagal membuat laporan regional.";
    } finally {
        connection.release();
    }
}

// --- 5. TEMPLATE HTML & RECEIPT ---
// Fungsi getReceiptHtml dan generateReceiptImage dihapus karena tidak menggunakan Puppeteer.

// --- 6. KEYBOARD & ACCESS CONTROL ---
function getMainMenuKeyboard(access) {
    let keyboard = [['📝 Buat Struk', '📊 Laporan Hari Ini'], ['🔍 Cari Transaksi', '📋 Transaksi Terakhir'], ['🔄 Ganti Toko', '/profil']];
    if (access.isRegionalHead) { keyboard.splice(1, 0, ['🌍 Laporan Regional']); }
    return { keyboard: keyboard, resize_keyboard: true };
}
function getPaymentMethodKeyboard() {
    return { keyboard: [['💳 QRIS', '💵 Tunai'], ['🏦 Debit BCA', '🏦 Transfer'], ['← Kembali']], resize_keyboard: true, one_time_keyboard: true };
}
function getYesNoKeyboard() {
    return { keyboard: [['✅ Ya', '❌ Tidak']], resize_keyboard: true, one_time_keyboard: true };
}
async function checkAccess(chatId) {
    const connection = await pool.getConnection();
    try {
        const [users] = await connection.execute(`SELECT u.*, r.name as role_name FROM users u LEFT JOIN roles r ON u.role_id = r.id WHERE u.telegram_chat_id = ?`, [chatId]);
        if (users.length === 0) return { hasAccess: false };
        const user = users[0];
        if (user.status !== 'active') return { hasAccess: false };
        let accessibleStores = [];
        const isRegionalHead = user.role_name === 'Kepala Cabang';
        const isStoreHead = user.role_name === 'Kepala Toko';
        if (isRegionalHead && user.region_id) {
            const [stores] = await connection.execute('SELECT id, name FROM stores WHERE region_id = ? AND status = "active"', [user.region_id]);
            accessibleStores = stores;
        } else if (isStoreHead) {
            const [stores] = await connection.execute(`SELECT s.id, s.name FROM user_store_access usa JOIN stores s ON usa.store_id = s.id WHERE usa.user_id = ? AND s.status = "active"`, [user.id]);
            accessibleStores = stores;
        }
        return { hasAccess: true, user: user, accessibleStores: accessibleStores, isRegionalHead, isStoreHead };
    } finally { connection.release(); }
}

// --- 7. BOT HANDLERS ---
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const access = await checkAccess(chatId);
    if (!access.hasAccess) { bot.sendMessage(chatId, "⚠️ Akses ditolak."); return; }
    const { user } = access;


   const primaryStore = await getStoreInfo(user.store_id);
    const activeStore = await getStoreInfo(user.active_store_id);

    let welcomeMessage = `🎉 *Selamat Datang, ${user.full_name}!*\n\n👑 Role: *${user.role_name}*\n`;
    
    if (primaryStore) {
        welcomeMessage += `🏢 Toko Utama: *${primaryStore.name}*\n`;
    }

    if (activeStore) {
        // Only show active store if it's different from the primary one
        if (!primaryStore || primaryStore.id !== activeStore.id) {
            welcomeMessage += `🏪 Toko Aktif (Sesi Ini): *${activeStore.name}*\n\n`;
        }
    } else {
        welcomeMessage += `⚠️ *Toko belum dipilih!* Gunakan menu *'🔄 Ganti Toko'* untuk memulai.\n\n`;
    }
    // --- AKHIR PERBAIKAN ---

    welcomeMessage += `Pilih menu di bawah:`;
    bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard(access) });
});

bot.onText(/\/profil/, async (msg) => {
    const chatId = msg.chat.id;
    const access = await checkAccess(chatId);
    if (!access.hasAccess) { bot.sendMessage(chatId, "⚠️ Akses ditolak."); return; }
    const { user } = access;


    const primaryStore = await getStoreInfo(user.store_id);
    const activeStore = await getStoreInfo(user.active_store_id);

    let profileMessage = `👤 *PROFIL ANDA*\n\n*Nama:* ${user.full_name}\n*Role:* ${user.role_name}\n`;

    if (user.role_name === 'Kepala Cabang' && user.region_id) {
        const [region] = await pool.execute('SELECT name FROM regions WHERE id = ?', [user.region_id]);
        profileMessage += `*Regional:* ${region.length > 0 ? region[0].name : 'N/A'}\n`;
    }

    // Display both primary and active store for clarity
    profileMessage += `*Toko Utama:* ${primaryStore ? primaryStore.name : 'Belum diatur'}\n`;
    profileMessage += `*Sesi Aktif di Toko:* ${activeStore ? activeStore.name : 'Belum dipilih'}\n`;
    // --- AKHIR PERBAIKAN ---
    
    bot.sendMessage(chatId, profileMessage, { parse_mode: 'Markdown' });
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const now = Date.now();
    const userLastRequest = userRequestTimestamps[chatId] || 0;
     if (now - userLastRequest < 1000) { 
        // Terlalu cepat, bisa kirim pesan peringatan atau abaikan saja
        return; 
    }
    userRequestTimestamps[chatId] = now;
    if (!text || text.startsWith('/')) return;
    const access = await checkAccess(chatId);
    if (!access.hasAccess) { bot.sendMessage(chatId, "⚠️ Akses ditolak."); return; }
    const mainMenuCommands = ['📝 Buat Struk', '📊 Laporan Hari Ini', '🌍 Laporan Regional', '🔍 Cari Transaksi', '📋 Transaksi Terakhir', '🔄 Ganti Toko'];
    if (mainMenuCommands.includes(text)) {
        delete userState[chatId];
        await handleMainMenu(chatId, text, access);
    } else if (userState[chatId]) {
        await handleConversationState(chatId, text, userState[chatId], access);
    } else {
        bot.sendMessage(chatId, "🤔 Perintah tidak dikenali.", { reply_markup: getMainMenuKeyboard(access) });
    }
});

// --- 8. MENU & CONVERSATION HANDLERS ---
async function handleMainMenu(chatId, text, access) {
    const { user } = access;
    if (!user.active_store_id && ['📝 Buat Struk', '📊 Laporan Hari Ini', '🔍 Cari Transaksi', '📋 Transaksi Terakhir'].includes(text)) {
        bot.sendMessage(chatId, "⚠️ *Aksi ditolak!* Pilih toko aktif via menu *'🔄 Ganti Toko'*.", { parse_mode: 'Markdown' });
        return;
    }
    switch (text) {
        case '📝 Buat Struk':
            userState[chatId] = { step: 'CASHIER_NAME', data: { items: [] } };
            bot.sendMessage(chatId, "✏️ Masukkan *Nama Kasir*:", { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
            break;
        case '📊 Laporan Hari Ini':
            bot.sendMessage(chatId, "⏳ Membuat laporan...");
            const report = await generateDailyReport(new Date(), user.active_store_id);
            bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
            break;
        case '🌍 Laporan Regional':
            if (!access.isRegionalHead) { bot.sendMessage(chatId, "⚠️ Fitur ini hanya untuk Kepala Cabang."); return; }
            bot.sendMessage(chatId, "⏳ Membuat laporan regional...");
            const regionalReport = await generateRegionalReport(new Date(), user.region_id);
            bot.sendMessage(chatId, regionalReport, { parse_mode: 'Markdown' });
            break;
        case '🔍 Cari Transaksi':
            userState[chatId] = { step: 'SEARCH_TRANSACTION' };
            bot.sendMessage(chatId, "🔍 Masukkan *invoice* atau *nama kasir*:", { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
            break;
        case '📋 Transaksi Terakhir':
             bot.sendMessage(chatId, "Fitur ini belum diimplementasikan. Silakan gunakan 'Cari Transaksi' untuk melihat data.");
            break;
        case '🔄 Ganti Toko':
            await showStoreSelection(chatId, access.accessibleStores);
            break;
    }
}

async function handleConversationState(chatId, text, state, access) {
    switch (state.step) {
        case 'CASHIER_NAME':
            const cashierName = text.trim();
            if (cashierName.length > 50) {
                bot.sendMessage(chatId, "⚠️ Nama kasir terlalu panjang.");
                return;
            }
            state.data.cashierName = cashierName;
            state.step = 'ADD_ITEM';

            // --- INSTRUKSI BARU YANG LEBIH SEDERHANA ---
            bot.sendMessage(chatId, `✅ Kasir: *${state.data.cashierName}*\n\nSekarang, masukkan item pertama dengan format:\n\`Nama, Jumlah, Unit, Modal/unit\`\n\n*Contoh:*\n\`Salsavage, 30, ml, 2000\`\n\`Botol PX38, 1, pcs, 7000\``, { parse_mode: 'Markdown' });
            break;

        case 'ADD_ITEM':
            if (text.toLowerCase().trim() === 'selesai') {
                if (state.data.items.length === 0) {
                    bot.sendMessage(chatId, "⚠️ Keranjang masih kosong. Tambahkan minimal satu item.");
                    return;
                }
                // --- LANJUT KE LANGKAH BARU: MEMINTA TOTAL BAYAR ---
                state.step = 'GET_TOTAL_PAYMENT';
                let itemSummary = "🛒 *Barang yang diinput:*\n";
                state.data.items.forEach((item, index) => {
                    itemSummary += `${index + 1}. ${item.name} (${item.qty} ${item.unit})\n`;
                });
                itemSummary += "\nSekarang, *berapa total uang yang dibayar oleh konsumen?*\nContoh: `130000`";
                bot.sendMessage(chatId, itemSummary, { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } });
                return;
            }

            // --- LOGIKA INPUT ITEM (HANYA 4 BAGIAN) ---
            const parts = text.split(',').map(p => p.trim());
            if (parts.length !== 4) {
                bot.sendMessage(chatId, "⚠️ Format salah. Gunakan: `Nama, Jumlah, Unit, Modal/unit`", { parse_mode: 'Markdown' });
                return;
            }
            
            const [name, qtyStr, unit, priceVpStr] = parts;
            const qty = parseInt(qtyStr);
            const priceVp = parseInt(priceVpStr.replace(/\./g, ''));

            if (!name || !unit || isNaN(qty) || isNaN(priceVp) || qty <= 0) {
                bot.sendMessage(chatId, "⚠️ Input tidak valid. Pastikan *Jumlah* dan *Modal* adalah angka.");
                return;
            }
            
            // Simpan item hanya dengan informasi modal
            state.data.items.push({ name, qty, unit, priceVp });

            // Tampilkan ringkasan item yang sudah masuk
            let summary = "✅ *Item ditambahkan:*\n";
            let totalModal = 0;
            state.data.items.forEach((item, index) => {
                summary += `${index + 1}. ${item.name}\n`;
                totalModal += item.qty * item.priceVp;
            });
            summary += `\n*Total Modal Sementara:* ${formatRupiah(totalModal)}\n\nMasukkan item berikutnya atau ketik *Selesai*.`;
            
            bot.sendMessage(chatId, summary, { parse_mode: 'Markdown', reply_markup: { keyboard: [['Selesai']], resize_keyboard: true, one_time_keyboard: true } });
            break;

        // --- STATE BARU UNTUK MENGAMBIL TOTAL BAYAR DARI KONSUMEN ---
        case 'GET_TOTAL_PAYMENT':
            const totalConsumerPayment = parseInt(text.replace(/\./g, ''));
            if (isNaN(totalConsumerPayment) || totalConsumerPayment <= 0) {
                bot.sendMessage(chatId, "⚠️ Masukkan total bayar dalam bentuk angka yang valid.");
                return;
            }
            state.data.totalConsumerPayment = totalConsumerPayment;
            state.step = 'PAYMENT_METHOD';
            bot.sendMessage(chatId, `💰 Total bayar konsumen: *${formatRupiah(totalConsumerPayment)}*.\n\nSekarang, pilih *Metode Pembayaran*`, { parse_mode: 'Markdown', reply_markup: getPaymentMethodKeyboard() });
            break;
        
        case 'PAYMENT_METHOD':
             if (text === '← Kembali') { 
                delete state.data.totalConsumerPayment; // Hapus data total bayar
                state.step = 'ADD_ITEM'; 
                bot.sendMessage(chatId, "Kembali ke penambahan item. Masukkan item lagi atau ketik *Selesai*.", { 
                    parse_mode: 'Markdown',
                    reply_markup: { keyboard: [['Selesai']], resize_keyboard: true, one_time_keyboard: true }
                }); 
                return; 
            }
            state.data.paymentMethod = text;
            state.step = 'CONFIRM_SAVE';
            
            // --- KONFIRMASI FINAL DENGAN PERHITUNGAN SELISIH ---
            let finalSummary = `📝 *KONFIRMASI TRANSAKSI*\n\nKasir: *${state.data.cashierName}*\n------------------------------------\n`;
            let totalModalFinal = 0;
            state.data.items.forEach(item => {
                finalSummary += `• ${item.name} (${item.qty} ${item.unit})\n`;
                totalModalFinal += item.qty * item.priceVp;
            });
            
            const finalTotal = state.data.totalConsumerPayment;
            const totalSelisih = finalTotal - totalModalFinal;

            finalSummary += `------------------------------------\n`;
            finalSummary += `💰 *Total Bayar:* *${formatRupiah(finalTotal)}*\n`;
            finalSummary += `📦 *Total Modal:* ${formatRupiah(totalModalFinal)}\n`;
            finalSummary += `📈 *Total Selisih:* *${formatRupiah(totalSelisih)}*\n\n`;
            finalSummary += `*Bayar via:* *${state.data.paymentMethod}*\n\nApakah data sudah benar?`;
            
            bot.sendMessage(chatId, finalSummary, { parse_mode: 'Markdown', reply_markup: getYesNoKeyboard() });
            break;

        case 'CONFIRM_SAVE':
            if (text === '✅ Ya') {
                // Notif tunggu
                bot.sendMessage(chatId, "⏳ Menyimpan transaksi...");
                
                state.data.invoiceNumber = `VP-${new Date().toISOString().slice(2, 10).replace(/-/g, "")}-${Date.now().toString().slice(-4)}`;

                try {
                    // --- LOGIKA PENTING: DISTRIBUSI HARGA JUAL (TETAP DIPERLUKAN UNTUK DATABASE) ---
                    const totalModalTrx = state.data.items.reduce((acc, item) => acc + (item.qty * item.priceVp), 0);
                    const totalConsumerPaymentTrx = state.data.totalConsumerPayment;

                    const processedItems = totalModalTrx > 0 ? state.data.items.map(item => {
                        const itemModal = item.qty * item.priceVp;
                        // Alokasikan pendapatan ke item secara proporsional berdasarkan modalnya
                        const itemRevenueShare = (itemModal / totalModalTrx) * totalConsumerPaymentTrx;
                        return { ...item, totalPriceConsumer: itemRevenueShare };
                    }) : state.data.items.map(item => ({...item, totalPriceConsumer: 0}));

                    const transactionData = {
                        ...state.data,
                        items: processedItems,
                    };

                    const { totalAmount } = await saveTransaction(transactionData, access.user.active_store_id, access.user.id);
                    
                    // --- HANYA KIRIM NOTIFIKASI BERHASIL DISIMPAN ---
                    bot.sendMessage(chatId, 
                        `✅ Transaksi \`${state.data.invoiceNumber}\` (Total: ${formatRupiah(totalAmount)}) berhasil disimpan di database.`, 
                        { 
                            parse_mode: 'Markdown', 
                            reply_markup: getMainMenuKeyboard(access) 
                        }
                    );

                } catch (error) {
                    console.error('❌ Gagal menyimpan transaksi:', error);
                    bot.sendMessage(chatId, "⚠️ Gagal menyimpan transaksi. Silakan coba lagi atau hubungi admin.", { 
                        parse_mode: 'Markdown',
                        reply_markup: getMainMenuKeyboard(access) 
                    });
                }
            } else {
                bot.sendMessage(chatId, "❌ Pembuatan struk dibatalkan.", { reply_markup: getMainMenuKeyboard(access) });
            }
            delete userState[chatId];
            break;
        
        // ... (Kode untuk 'EDIT_CASHIER' sampai 'SEARCH_TRANSACTION' tetap sama) ...
        case 'EDIT_CASHIER':
            state.currentData.cashier_name = text.trim();
            state.step = 'EDIT_MENU';
            await showEditMenu(chatId, state, access);
            break;

        case 'EDIT_PAYMENT':
            if (text === '← Kembali') {
                state.step = 'EDIT_MENU';
                await showEditMenu(chatId, state, access);
                return;
            }
            state.currentData.payment_method = text.trim();
            state.step = 'EDIT_MENU';
            await showEditMenu(chatId, state, access);
            break;

        case 'EDIT_ADD_ITEM':
            const addParts = text.split(',').map(p => p.trim());
            if (addParts.length !== 5) {
                bot.sendMessage(chatId, "⚠️ Format salah. Gunakan: `Nama, Jumlah, Unit, Harga Modal, Total Bayar`");
                break;
            }
            const [addName, addQty, addUnit, addPriceVp, addPriceConsumer] = addParts;
            if (isNaN(parseInt(addQty)) || isNaN(parseInt(addPriceVp)) || isNaN(parseInt(addPriceConsumer))) {
                bot.sendMessage(chatId, "⚠️ Pastikan Jumlah & Harga adalah angka.");
                break;
            }
            state.currentData.items.push({
                name: addName,
                qty: parseInt(addQty),
                unit: addUnit,
                priceVp: parseInt(addPriceVp),
                totalPriceConsumer: parseInt(addPriceConsumer)
            });
            state.step = 'EDIT_MENU';
            await showEditMenu(chatId, state, access);
            break;
            
        case 'EDIT_REMOVE_ITEM':
            const itemIndexToRemove = parseInt(text.trim()) - 1;
            if (!isNaN(itemIndexToRemove) && itemIndexToRemove >= 0 && itemIndexToRemove < state.currentData.items.length) {
                state.currentData.items.splice(itemIndexToRemove, 1);
                state.step = 'EDIT_MENU';
                await showEditMenu(chatId, state, access);
            } else {
                bot.sendMessage(chatId, "⚠️ Nomor item tidak valid.");
            }
            break;

        case 'EDIT_UPDATE_ITEM_DATA':
            const updateParts = text.split(',').map(p => p.trim());
            if (updateParts.length !== 5) {
                bot.sendMessage(chatId, "⚠️ Format salah. Gunakan: `Nama, Jumlah, Unit, Harga Modal, Total Bayar`");
                break;
            }
            const [updateName, updateQty, updateUnit, updatePriceVp, updatePriceConsumer] = updateParts;
            if (isNaN(parseInt(updateQty)) || isNaN(parseInt(updatePriceVp)) || isNaN(parseInt(updatePriceConsumer))) {
                bot.sendMessage(chatId, "⚠️ Pastikan Jumlah & Harga adalah angka.");
                break;
            }
            
            const itemToUpdate = state.currentData.items[state.editingItemIndex];
            if (itemToUpdate) {
                itemToUpdate.name = updateName;
                itemToUpdate.product_name = updateName; // update both keys for consistency
                itemToUpdate.qty = parseInt(updateQty);
                itemToUpdate.quantity = parseInt(updateQty);
                itemToUpdate.unit = updateUnit;
                itemToUpdate.priceVp = parseInt(updatePriceVp);
                itemToUpdate.totalPriceConsumer = parseInt(updatePriceConsumer);
                // Recalculate per-unit price for database consistency
                itemToUpdate.price_consumer = itemToUpdate.totalPriceConsumer / itemToUpdate.qty;

            }
            delete state.editingItemIndex;
            state.step = 'EDIT_MENU';
            await showEditMenu(chatId, state, access);
            break;

        case 'EDIT_ITEM_NAME':
            if (!state.currentData.items[state.editingItemIndex]) break;
            state.currentData.items[state.editingItemIndex].name = text.trim();
            state.currentData.items[state.editingItemIndex].product_name = text.trim();
            state.step = 'EDIT_MENU_ITEM';
            await showItemEditMenu(chatId, state);
            break;

        case 'EDIT_ITEM_QTY':
            if (!state.currentData.items[state.editingItemIndex]) break;
            const qtyParts = text.split(',').map(p => p.trim());
            if (qtyParts.length !== 2 || isNaN(parseInt(qtyParts[0]))) {
                bot.sendMessage(chatId, "Format salah. Contoh: `30, ml`");
                break;
            }
            state.currentData.items[state.editingItemIndex].qty = parseInt(qtyParts[0]);
            state.currentData.items[state.editingItemIndex].quantity = parseInt(qtyParts[0]);
            state.currentData.items[state.editingItemIndex].unit = qtyParts[1];
            state.step = 'EDIT_MENU_ITEM';
            await showItemEditMenu(chatId, state);
            break;

        case 'EDIT_ITEM_PRICE_VP':
            if (!state.currentData.items[state.editingItemIndex]) break;
            const newPriceVp = parseInt(text.replace(/\./g, ''));
            if (isNaN(newPriceVp)) {
                bot.sendMessage(chatId, "Masukkan angka yang valid.");
                break;
            }
            state.currentData.items[state.editingItemIndex].priceVp = newPriceVp;
            state.step = 'EDIT_MENU_ITEM';
            await showItemEditMenu(chatId, state);
            break;

        case 'EDIT_ITEM_TOTAL_CONSUMER':
            if (!state.currentData.items[state.editingItemIndex]) break;
            const newTotalConsumer = parseInt(text.replace(/\./g, ''));
            if (isNaN(newTotalConsumer)) {
                bot.sendMessage(chatId, "Masukkan angka yang valid.");
                break;
            }
            state.currentData.items[state.editingItemIndex].totalPriceConsumer = newTotalConsumer;
            state.step = 'EDIT_MENU_ITEM';
            await showItemEditMenu(chatId, state);
            break;
                
        case 'SEARCH_TRANSACTION':
            const invoiceQuery = text.trim();
            const transaction = await findTransactionByInvoice(invoiceQuery, access.user.active_store_id);

            if (!transaction) {
                bot.sendMessage(chatId, `❌ Transaksi dengan invoice \`${invoiceQuery}\` tidak ditemukan di toko ini.`, { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard(access) });
            } else {
                let detailMessage = `✅ *Transaksi Ditemukan*\n\n`;
                detailMessage += `🧾 *Invoice:* \`${transaction.invoice_number}\`\n`;
                detailMessage += `🏪 *Toko:* ${transaction.store_name}\n`;
                detailMessage += `👤 *Kasir:* ${transaction.cashier_name}\n`;
                detailMessage += `📅 *Tanggal:* ${formatDate(transaction.transaction_date)}\n`;
                detailMessage += `💳 *Bayar:* ${transaction.payment_method}\n`;
                detailMessage += `------------------------------------\n`;
                
                transaction.items.forEach(item => {
                    detailMessage += `• ${item.name} (${item.qty} ${item.unit}) - ${formatRupiah(item.totalPriceConsumer)}\n`;
                });

                detailMessage += `------------------------------------\n`;
                detailMessage += `💰 *TOTAL:* *${formatRupiah(transaction.total_amount)}*\n`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '✏️ Edit Transaksi Ini', callback_data: `edit_${transaction.invoice_number}` }]
                    ]
                };
                bot.sendMessage(chatId, detailMessage, { parse_mode: 'Markdown', reply_markup: keyboard });
            }
            delete userState[chatId];
            break;
    }
}

// Fungsi baru untuk menampilkan menu edit
async function showEditMenu(chatId, state, access) {
    const { currentData } = state;
    let editMessage = `✏️ *Mode Edit: ${currentData.invoice_number}*\n\n`;
    editMessage += `Kasir: *${currentData.cashier_name}*\n`;
    editMessage += `Bayar: *${currentData.payment_method}*\n`;
    editMessage += `------------------------------------\n`;
    let total = 0;
    currentData.items.forEach((item, index) => {
        const itemTotal = item.totalPriceConsumer || (item.price_consumer * item.quantity);
        editMessage += `${index + 1}. ${item.name || item.product_name} (${item.qty || item.quantity} ${item.unit}) - ${formatRupiah(itemTotal)}\n`;
        total += itemTotal;
    });
    editMessage += `------------------------------------\n`;
    editMessage += `TOTAL: *${formatRupiah(total)}*\n\n`;
    editMessage += `Pilih data yang ingin diubah:`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '👤 Ubah Kasir', callback_data: 'edit_field_cashier' }, { text: '💳 Ubah Pembayaran', callback_data: 'edit_field_payment' }],
            [{ text: '➕ Tambah Item', callback_data: 'edit_field_add_item' }, { text: '🗑️ Hapus Item', callback_data: 'edit_field_remove_item' }],
            [{ text: '✏️ Ubah Item', callback_data: 'edit_field_edit_item' }],
            [{ text: '✅ Simpan Perubahan', callback_data: 'edit_save' }],
            [{ text: '❌ Batal', callback_data: 'edit_cancel' }]
        ]
    };

    if (state.editMessageId) {
        await bot.editMessageText(editMessage, {
            chat_id: chatId,
            message_id: state.editMessageId,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        }).catch(() => { // Jika gagal edit (misal, pesan terlalu tua), kirim baru
            bot.sendMessage(chatId, editMessage, { parse_mode: 'Markdown', reply_markup: keyboard })
               .then(msg => state.editMessageId = msg.message_id);
        });
    } else {
        const sentMessage = await bot.sendMessage(chatId, editMessage, { parse_mode: 'Markdown', reply_markup: keyboard });
        state.editMessageId = sentMessage.message_id;
    }
}

async function showItemEditMenu(chatId, state) {
    const item = state.currentData.items[state.editingItemIndex];
    if (!item) {
        // Jika item tidak ada, kembali ke menu utama
        await showEditMenu(chatId, state, {});
        return;
    }

    const itemName = item.name || item.product_name;
    const itemQty = item.qty || item.quantity;
    const itemUnit = item.unit;
    const itemPriceVp = item.priceVp;
    const itemTotalPriceConsumer = item.totalPriceConsumer;

    let message = `✏️ *Mengubah Item: ${itemName}*\n\n`;
    message += `*Detail Saat Ini:*\n`;
    message += `1. Nama: ${itemName}\n`;
    message += `2. Jumlah: ${itemQty} ${itemUnit}\n`;
    message += `3. Harga Modal/unit: ${formatRupiah(itemPriceVp)}\n`;
    message += `4. Total Bayar Konsumen: ${formatRupiah(itemTotalPriceConsumer)}\n\n`;
    message += `Pilih bagian yang ingin diubah:`;

    const keyboard = {
        inline_keyboard: [
            [{ text: '1. Nama', callback_data: 'edit_item_field_name' }, { text: '2. Jumlah & Unit', callback_data: 'edit_item_field_qty' }],
            [{ text: '3. Harga Modal', callback_data: 'edit_item_field_price_vp' }, { text: '4. Total Bayar', callback_data: 'edit_item_field_total_consumer' }],
            [{ text: '« Kembali ke Struk', callback_data: 'edit_item_back' }]
        ]
    };
    
    // Gunakan kembali messageId yang sudah ada untuk mengedit pesan
    if (state.editMessageId) {
        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: state.editMessageId,
            parse_mode: 'Markdown',
            reply_markup: keyboard
        });
    } else {
        const sentMessage = await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', reply_markup: keyboard });
        state.editMessageId = sentMessage.message_id;
    }
}


// --- 9. FUNGSI TAMPILAN & CALLBACK ---

async function showStoreSelection(chatId, stores) {
    if (!stores || stores.length === 0) { bot.sendMessage(chatId, "⚠️ Tidak ada toko yang bisa Anda akses."); return; }
    const keyboard = stores.map(store => ([{ text: `🏪 ${store.name}`, callback_data: `set_active_store_${store.id}` }]));
    bot.sendMessage(chatId, "📍 Silakan pilih toko yang ingin Anda operasikan:", { reply_markup: { inline_keyboard: keyboard } });
}

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const msg = query.message;
    const access = await checkAccess(chatId);
    if (!access.hasAccess) {
        bot.answerCallbackQuery(query.id, { text: '⚠️ Akses ditolak.' });
        return;
    }

    if (data.startsWith('set_active_store_')) {
        const storeId = data.replace('set_active_store_', '');
        const store = access.accessibleStores.find(s => s.id == storeId);
        if (!store) {
            bot.answerCallbackQuery(query.id, { text: 'Akses ke toko ini ditolak!', show_alert: true });
            return;
        }
        await pool.execute('UPDATE users SET active_store_id = ? WHERE id = ?', [storeId, access.user.id]);
        bot.editMessageText(`✅ Berhasil! Anda sekarang aktif di toko *${store.name}*. Gunakan /start untuk melihat menu.`, { chat_id: chatId, message_id: msg.message_id, parse_mode: 'Markdown' });
        bot.answerCallbackQuery(query.id);
        return;
    }

    // --- LOGIKA EDIT FINAL ---
    if (data.startsWith('edit_')) {
        const state = userState[chatId];
        const isAllowedToEdit = access.isRegionalHead || access.isStoreHead;

        if (!isAllowedToEdit) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Anda tidak punya hak akses untuk edit.', show_alert: true });
            return;
        }

        // Urutan if/else if ini sangat penting untuk mencegah bug
        
        // 1. Aksi di dalam menu edit item (paling spesifik)
        if (data.startsWith('edit_item_field_')) {
            if (!state) return bot.answerCallbackQuery(query.id);
            const field = data.replace('edit_item_field_', '');
            
            switch(field) {
                case 'name':
                    state.step = 'EDIT_ITEM_NAME';
                    bot.sendMessage(chatId, "✏️ Masukkan *nama barang* baru:", { parse_mode: 'Markdown'});
                    break;
                case 'qty':
                    state.step = 'EDIT_ITEM_QTY';
                    bot.sendMessage(chatId, "✏️ Masukkan *jumlah* dan *unit* baru (pisahkan dengan koma).\nContoh: `30, ml`", { parse_mode: 'Markdown'});
                    break;
                case 'price_vp':
                    state.step = 'EDIT_ITEM_PRICE_VP';
                    bot.sendMessage(chatId, "✏️ Masukkan *harga modal per unit* baru:", { parse_mode: 'Markdown'});
                    break;
                case 'total_consumer':
                    state.step = 'EDIT_ITEM_TOTAL_CONSUMER';
                    bot.sendMessage(chatId, "✏️ Masukkan *total harga bayar konsumen* yang baru untuk item ini:", { parse_mode: 'Markdown'});
                    break;
            }
            await bot.deleteMessage(chatId, state.editMessageId).catch(()=>{});
            state.editMessageId = null;

        // 2. Tombol kembali dari menu edit item
        } else if (data === 'edit_item_back') {
            if (!state) return bot.answerCallbackQuery(query.id);
            delete state.editingItemIndex;
            state.step = 'EDIT_MENU';
            await showEditMenu(chatId, state, access);
        
        // 3. Memilih item dari daftar untuk diedit
        } else if (data.startsWith('edit_item_idx_')) {
            if (!state) return bot.answerCallbackQuery(query.id);
            const index = parseInt(data.replace('edit_item_idx_', ''));
            state.editingItemIndex = index;
            state.step = 'EDIT_MENU_ITEM';
            await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            await showItemEditMenu(chatId, state);

        // 4. Aksi di dalam menu edit utama (struk)
        } else if (data.startsWith('edit_field_')) {
            if (!state) return bot.answerCallbackQuery(query.id);
            const field = data.replace('edit_field_', '');
            await bot.deleteMessage(chatId, msg.message_id).catch(() => {});
            state.editMessageId = null;

            switch (field) {
                case 'cashier':      state.step = 'EDIT_CASHIER'; bot.sendMessage(chatId, "✏️ Masukkan nama kasir baru:"); break;
                case 'payment':      state.step = 'EDIT_PAYMENT'; bot.sendMessage(chatId, "💳 Pilih metode pembayaran baru:", { reply_markup: getPaymentMethodKeyboard() }); break;
                case 'add_item':     state.step = 'EDIT_ADD_ITEM'; bot.sendMessage(chatId, "➕ Masukkan item baru:\n`Nama, Jumlah, Unit, Harga Modal, Total Bayar Konsumen`\n\n*Contoh:*\n`Baccarat, 30, ml, 2000, 90000`", { parse_mode: 'Markdown' }); break;
                case 'remove_item':
                    if (state.currentData.items.length === 0) { bot.answerCallbackQuery(query.id, { text: "Tidak ada item untuk dihapus." }); return; }
                    state.step = 'EDIT_REMOVE_ITEM';
                    let itemList = "🗑️ Ketik *nomor* item yang ingin dihapus:\n\n";
                    state.currentData.items.forEach((item, i) => { itemList += `${i + 1}. ${item.name || item.product_name}\n`; });
                    bot.sendMessage(chatId, itemList, { parse_mode: 'Markdown' });
                    break;
                case 'edit_item':
                    if (state.currentData.items.length === 0) { bot.answerCallbackQuery(query.id, { text: "Tidak ada item untuk diubah." }); return; }
                    state.step = 'EDIT_SELECT_ITEM';
                    let editKeyboard = state.currentData.items.map((item, i) => ([{ text: `${i + 1}. ${item.name || item.product_name}`, callback_data: `edit_item_idx_${i}` }]));
                    bot.sendMessage(chatId, "✏️ Pilih item yang akan diubah:", { reply_markup: { inline_keyboard: editKeyboard } });
                    break;
            }

        // 5. Tombol Simpan
        } else if (data === 'edit_save') {
            if (!state) return bot.answerCallbackQuery(query.id);
            try {
                await bot.editMessageText(`⏳ Menyimpan perubahan untuk invoice \`${state.invoiceNumber}\`...`, { chat_id: chatId, message_id: state.editMessageId, parse_mode: 'Markdown' });
                await updateTransaction(state.invoiceNumber, state.currentData, access.user.id);
                bot.sendMessage(chatId, `✅ Invoice \`${state.invoiceNumber}\` berhasil diperbarui!`, { parse_mode: 'Markdown', reply_markup: getMainMenuKeyboard(access) });
            } catch (error) {
                bot.sendMessage(chatId, '❌ Gagal menyimpan perubahan.', { reply_markup: getMainMenuKeyboard(access) });
            } finally {
                delete userState[chatId];
            }

        // 6. Tombol Batal
        } else if (data === 'edit_cancel') {
            if (!state) return bot.answerCallbackQuery(query.id);
            delete userState[chatId];
            bot.editMessageText(`❌ Edit invoice dibatalkan.`, { chat_id: chatId, message_id: msg.message_id });
            bot.sendMessage(chatId, "Pilih menu selanjutnya:", { reply_markup: getMainMenuKeyboard(access) });
        
        // 7. Blok untuk memulai sesi edit (paling tidak spesifik, ditaruh terakhir)
        } else { 
            const invoiceNumber = data.replace('edit_', '');
            const transaction = await findTransactionByInvoice(invoiceNumber, access.user.active_store_id);
            if (!transaction) {
                bot.answerCallbackQuery(query.id, { text: '❌ Transaksi tidak ditemukan.', show_alert: true });
                return;
            }
            userState[chatId] = {
                step: 'EDIT_MENU',
                invoiceNumber: invoiceNumber,
                currentData: transaction,
                editMessageId: msg.message_id
            };
            await showEditMenu(chatId, userState[chatId], access);
        }
        bot.answerCallbackQuery(query.id);
        return;
    }
});

// --- 10. SERVER & STARTUP ---
app.get('/', (req, res) => {
    res.send(`<div style="font-family: Arial, sans-serif; text-align: center; margin-top: 20%;"><h1>🤖 Bot Telegram VillaParfum Aktif</h1><p>Sistem Multi-Toko & Multi-Peran berjalan dengan baik.</p></div>`);
});
app.listen(PORT, async () => {
    try {
        await pool.query('SELECT 1');
        console.log('✅ Koneksi ke database MySQL berhasil.');
        console.log(`🚀 Server berjalan di port ${PORT}`);
        console.log('🤖 Bot Telegram berhasil diaktifkan.');
    } catch (error) { console.error('❌ Gagal terhubung ke database MySQL:', error.message); process.exit(1); }
});
process.on('SIGINT', async () => {
    console.log('\n⏸️ Mematikan bot...');
    await pool.end();
    bot.stopPolling();
    process.exit(0);
});
bot.on('polling_error', (error) => console.error('❌ Polling error:', error.code, error.message));