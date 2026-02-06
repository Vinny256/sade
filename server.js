require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors()); // Allows MikroTik to talk to Render
app.use(bodyParser.json());

// 1. Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ Sade Net Database Connected"))
    .catch(err => console.error("❌ DB Connection Error:", err));

const TransactionSchema = new mongoose.Schema({
    phoneNumber: String,
    amount: Number,
    plan: String,
    checkoutRequestID: String,
    status: { type: String, default: 'Pending' },
    mpesaReceipt: String,
    createdAt: { type: Date, default: Date.now }
});
const Transaction = mongoose.model('Transaction', TransactionSchema);

// 2. Helper: Get Live M-Pesa Token
const getMpesaToken = async () => {
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
    try {
        const response = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            headers: { Authorization: `Basic ${auth}` }
        });
        return response.data.access_token;
    } catch (error) {
        console.error("Token Error:", error.response?.data || error.message);
        throw new Error("Failed to get Safaricom Token");
    }
};

// 3. Keep-Alive / Health Check
app.get('/ping', (req, res) => res.json({ status: "Awake" }));

// 4. Live STK Push Route
app.post('/stk-push', async (req, res) => {
    let { phone, plan, amount } = req.body;

    // Format Phone: 07xx -> 2547xx
    if (phone.startsWith('0')) phone = '254' + phone.substring(1);
    if (phone.startsWith('7')) phone = '254' + phone;

    try {
        const token = await getMpesaToken();
        const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
        const password = Buffer.from(`${process.env.BUSINESS_SHORT_CODE}${process.env.PASSKEY}${timestamp}`).toString('base64');

        const requestData = {
            BusinessShortCode: process.env.BUSINESS_SHORT_CODE,
            Password: password,
            Timestamp: timestamp,
            TransactionType: "CustomerPayBillOnline", // Use CustomerBuyGoodsOnline if using a Till
            Amount: amount,
            PartyA: phone,
            PartyB: process.env.BUSINESS_SHORT_CODE,
            PhoneNumber: phone,
            CallBackURL: process.env.CALLBACK_URL,
            AccountReference: "SADE NET",
            TransactionDesc: `WiFi ${plan}`
        };

        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpush/v1/query',
            requestData,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        const newTx = new Transaction({
            phoneNumber: phone,
            amount: amount,
            plan: plan,
            checkoutRequestID: response.data.CheckoutRequestID
        });
        await newTx.save();

        res.status(200).json({ success: true, checkoutID: response.data.CheckoutRequestID });
    } catch (error) {
        console.error("STK Error:", error.response?.data || error.message);
        res.status(500).json({ error: "M-Pesa session failed" });
    }
});

// 5. Live Callback Listener
app.post('/callback', async (req, res) => {
    const { Body: { stkCallback } } = req.body;
    
    const checkoutID = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;

    if (resultCode === 0) {
        // Find receipt number in metadata
        const metadata = stkCallback.CallbackMetadata.Item;
        const receipt = metadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;

        await Transaction.findOneAndUpdate(
            { checkoutRequestID: checkoutID }, 
            { status: 'Success', mpesaReceipt: receipt }
        );
        console.log(`💰 Success: ${receipt} for ${checkoutID}`);
    } else {
        await Transaction.findOneAndUpdate({ checkoutRequestID: checkoutID }, { status: 'Failed' });
    }
    res.json("Accepted");
});

// 6. Polling: Frontend checks if paid
app.get('/status/:checkoutID', async (req, res) => {
    const tx = await Transaction.findOne({ checkoutRequestID: req.params.checkoutID });
    if (tx && tx.status === 'Success') {
        res.json({ paid: true, plan: tx.plan });
    } else {
        res.json({ paid: false });
    }
});

// 7. Admin: Get Stats
app.get('/admin/sales', async (req, res) => {
    const sales = await Transaction.find({ status: 'Success' }).sort({ createdAt: -1 });
    res.json(sales);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Sade Net Live on Port ${PORT}`));