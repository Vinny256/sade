require('dotenv').config();
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const cors = require('cors');
const morgan = require('morgan');

const app = express();

// 1. MIDDLEWARE & LOGGING
app.use(cors());
app.use(bodyParser.json());
// Aggressive logging for Render
app.use(morgan(':method :url :status :res[content-length] - :response-time ms'));

// 2. DATABASE CONNECTION (For Admin Portal)
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

// --- NEW CODE START: THE PULL QUEUE & LOGGING ---
// This temporary list stores paid users until the MikroTik fetches them
let paidQueue = []; 

// Endpoint for MikroTik to pull the latest paid user
app.get('/latest-paid', (req, res) => {
    const timestamp = new Date().toLocaleTimeString();
    if (paidQueue.length > 0) {
        // Take the first user in the line
        const nextUser = paidQueue.shift(); 
        console.log(`📡 [MikroTik Pull] SUCCESS: Sending ${nextUser.phone} to Router at ${timestamp}`);
        console.log(`📊 [Queue Status] Remaining in queue: ${paidQueue.length}`);
        
        // Format the response exactly how the MikroTik script expects: "phone,plan"
        res.send(`${nextUser.phone},${nextUser.plan}`);
    } else {
        // Log that the router checked but no one was in the queue
        console.log(`🔍 [MikroTik Pull] IDLE: Router checked for users at ${timestamp} (Queue Empty)`);
        res.send("none,none");
    }
});

// TEST ROUTE: To verify the bridge without paying
app.get('/test-success', (req, res) => {
    const { phone, plan } = req.query;
    if (!phone || !plan) {
        return res.status(400).send("Missing phone or plan parameters. Example: ?phone=0700123456&plan=10_sh_1hr");
    }
    paidQueue.push({ phone, plan });
    console.log(`🧪 [Test] Manual entry added: ${phone} for ${plan}`);
    res.send(`✅ Success! ${phone} is now waiting for the MikroTik to pull it.`);
});

// MONITOR ROUTE: To see the current queue size
app.get('/queue-monitor', (req, res) => {
    res.json({
        activeQueueLength: paidQueue.length,
        currentQueue: paidQueue,
        serverTime: new Date().toLocaleTimeString()
    });
});
// --- NEW CODE END ---

// 3. LIVE OAUTH TOKEN HELPER
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

// 4. MIKROTIK PINGER (Keep-Alive)
app.get('/ping', (req, res) => {
    console.log(`📡 [MikroTik] Heartbeat received at ${new Date().toLocaleTimeString()}`);
    res.json({ status: "Vinnie Digital Hub is Awake" });
});

// 5. STK PUSH (LIVE)
app.post('/stk-push', async (req, res) => {
    let { phone, plan, amount } = req.body;
    console.log(`🖱️ [Frontend] Button Clicked! Plan: ${plan}, Phone: ${phone}`);

    // Format: 07... to 2547...
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
            TransactionType: "CustomerPayBillOnline", // "CustomerBuyGoodsOnline" for Till
            Amount: amount,
            PartyA: phone,
            PartyB: process.env.BUSINESS_SHORT_CODE,
            PhoneNumber: phone,
            CallBackURL: process.env.CALLBACK_URL,
            AccountReference: "SADE NET",
            TransactionDesc: `WiFi Access: ${plan}`
        };

        console.log(`📤 [Safaricom] Sending STK Push to ${phone} for ${amount}/=`);
        
        // FIXED ENDPOINT FOR LIVE PRODUCTION
        const response = await axios.post(
            'https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
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
        console.error("❌ [STK Error]:", JSON.stringify(error.response?.data || error.message, null, 2));
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
        console.log(`💰 [Payment SUCCESS] Receipt: ${receipt} for ID: ${checkoutID}`);

        // Update database
        const updatedTx = await Transaction.findOneAndUpdate(
            { checkoutRequestID: checkoutID }, 
            { status: 'Success', mpesaReceipt: receipt },
            { new: true }
        );

        // --- NEW LOGIC: ADD TO QUEUE FOR MIKROTIK ---
        if (updatedTx) {
            paidQueue.push({ phone: updatedTx.phoneNumber, plan: updatedTx.plan });
            console.log(`📝 [Queue] SUCCESS: Added ${updatedTx.phoneNumber} to WinBox pull queue.`);
        }
        // --------------------------------------------

    } else {
        console.log(`⚠️ [Payment FAILED] ID: ${checkoutID}, Code: ${resultCode}`);
        await Transaction.findOneAndUpdate({ checkoutRequestID: checkoutID }, { status: 'Failed' });
    }
    res.json({ ResultCode: 0, ResultDesc: "Success" });
});

// 7. STATUS POLLING
app.get('/status/:checkoutID', async (req, res) => {
    const tx = await Transaction.findOne({ checkoutRequestID: req.params.checkoutID });
    if (tx && tx.status === 'Success') {
        console.log(`🔓 [Access] Plan granted for ${tx.phoneNumber}`);
        res.json({ paid: true, plan: tx.plan });
    } else {
        res.json({ paid: false });
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => console.log(`🚀 [Server] Sade Net LIVE on Port ${PORT}`));