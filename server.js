require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const morgan = require('morgan');

const app = express();

// 1. MIDDLEWARE SETUP
app.use(cors());
app.use(bodyParser.json());

// CUSTOM LOGGING: Shows Method, URL, Status, and Response Time in Render Logs
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// 2. DATABASE CONNECTION
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ [DB] Connected to Sade Net Database"))
    .catch(err => console.error("❌ [DB] Connection Error:", err));

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

// 3. OAUTH TOKEN HELPER (LIVE)
const getMpesaToken = async () => {
    console.log("🔑 [Auth] Requesting M-Pesa Access Token...");
    const auth = Buffer.from(`${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`).toString('base64');
    try {
        const response = await axios.get('https://api.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
            headers: { Authorization: `Basic ${auth}` }
        });
        console.log("✅ [Auth] Token received successfully.");
        return response.data.access_token;
    } catch (error) {
        console.error("❌ [Auth] Error:", error.response?.data || error.message);
        throw error;
    }
};

// 4. KEEP-ALIVE (MIKROTIK PING)
app.get('/ping', (req, res) => {
    console.log(`📡 [MikroTik] Heartbeat received at ${new Date().toLocaleTimeString()}`);
    res.json({ status: "Vinnie Digital Hub is Awake" });
});

// 5. STK PUSH INITIATION (LIVE)
app.post('/stk-push', async (req, res) => {
    let { phone, plan, amount } = req.body;
    console.log(`🖱️ [Frontend] Button Clicked! Plan: ${plan}, Phone: ${phone}`);

    // Convert 07... to 2547...
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
            TransactionType: "CustomerPayBillOnline", // Change to "CustomerBuyGoodsOnline" if using Till
            Amount: amount,
            PartyA: phone,
            PartyB: process.env.BUSINESS_SHORT_CODE,
            PhoneNumber: phone,
            CallBackURL: process.env.CALLBACK_URL,
            AccountReference: "SADE NET",
            TransactionDesc: `WiFi Access: ${plan}`
        };

        console.log(`📤 [Safaricom] Sending STK Push to ${phone} for ${amount}/=`);
        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpush/v1/query',
            requestData,
            { headers: { Authorization: `Bearer ${token}` } }
        );

        console.log(`🚀 [Safaricom] STK Accepted! CheckoutID: ${response.data.CheckoutRequestID}`);

        const newTx = new Transaction({
            phoneNumber: phone,
            amount: amount,
            plan: plan,
            checkoutRequestID: response.data.CheckoutRequestID
        });
        await newTx.save();

        res.status(200).json({ success: true, checkoutID: response.data.CheckoutRequestID });
    } catch (error) {
        console.error("❌ [STK Error]:", error.response?.data || error.message);
        res.status(500).json({ error: "Failed to trigger M-Pesa prompt" });
    }
});

// 6. MPESA CALLBACK (LIVE)
app.post('/callback', async (req, res) => {
    console.log("📩 [Safaricom] New Callback Received!");
    const { Body: { stkCallback } } = req.body;
    
    const checkoutID = stkCallback.CheckoutRequestID;
    const resultCode = stkCallback.ResultCode;

    if (resultCode === 0) {
        const metadata = stkCallback.CallbackMetadata.Item;
        const receipt = metadata.find(item => item.Name === 'MpesaReceiptNumber')?.Value;
        const paidAmount = metadata.find(item => item.Name === 'Amount')?.Value;

        console.log(`💰 [Payment SUCCESS] Receipt: ${receipt}, Amount: ${paidAmount}, ID: ${checkoutID}`);

        await Transaction.findOneAndUpdate(
            { checkoutRequestID: checkoutID }, 
            { status: 'Success', mpesaReceipt: receipt }
        );
    } else {
        console.log(`⚠️ [Payment FAILED/CANCELLED] ID: ${checkoutID}, Code: ${resultCode}`);
        await Transaction.findOneAndUpdate({ checkoutRequestID: checkoutID }, { status: 'Failed' });
    }
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// 7. POLLING FOR FRONTEND
app.get('/status/:checkoutID', async (req, res) => {
    const tx = await Transaction.findOne({ checkoutRequestID: req.params.checkoutID });
    if (tx && tx.status === 'Success') {
        console.log(`🔓 [Access] Plan granted for ${tx.phoneNumber}`);
        res.json({ paid: true, plan: tx.plan });
    } else {
        res.json({ paid: false });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 [Server] Sade Net LIVE on Port ${PORT}`));