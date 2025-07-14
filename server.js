// backend/server.js

const express = require("express");
const cors = require("cors");
// --- CORRECTED IMPORT ---
// Import the builder along with the client and environment
const { StandardCheckoutClient, Env, StandardCheckoutPayRequest } = require("pg-sdk-node"); 
const { randomUUID } = require("crypto");
const admin = require("firebase-admin");

// --- CONFIGURATION ---
// Load environment variables from a .env file
require("dotenv").config();

const PORT = process.env.PORT || 5000;
const PHONEPE_CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const PHONEPE_CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const PHONEPE_CLIENT_VERSION = 1; // As per docs
const MERCHANT_ID = process.env.MERCHANT_ID; // Your PhonePe Merchant ID


// ✅ Conditionally set URLs based on the environment
const isProduction = process.env.NODE_ENV === 'production';
const BACKEND_URL = isProduction ? process.env.PROD_BACKEND_URL : process.env.DEV_BACKEND_URL;
const FRONTEND_URL = isProduction ? process.env.PROD_FRONTEND_URL : process.env.DEV_FRONTEND_URL;


// Firebase Admin SDK Configuration
// Make sure you have the 'firebase-service-account.json' file in your project root
const serviceAccount = require("./firebase-service-account.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// --- INITIALIZATION ---
const app = express();
app.use(cors());
app.use(express.json());

// ✅ Initialize PhonePe client based on the environment
const phonepeClient = StandardCheckoutClient.getInstance(
  PHONEPE_CLIENT_ID,
  PHONEPE_CLIENT_SECRET,
  PHONEPE_CLIENT_VERSION,
  isProduction ? Env.PRODUCTION : Env.UAT // Use PRODUCTION for live, UAT for development
);


// --- API ENDPOINTS ---

/**
 * @route   POST /api/pay
 * @desc    Initiate a payment with PhonePe
 * @access  Public
 */
app.post("/api/pay", async (req, res) => {
  try {
    const { amount, products, shippingDetails, userId } = req.body;

    if (!amount || !products || !shippingDetails || !userId) {
      return res.status(400).json({ success: false, message: "Missing required payment data." });
    }

    const merchantOrderId = `M-${randomUUID().slice(0, 6)}`;
    
    // URL the user is redirected to after payment completion/failure on PhonePe page
    const redirectUrl = `${FRONTEND_URL}/payment-status/${merchantOrderId}`;
    // URL PhonePe sends server-to-server callback to
    const callbackUrl = `${BACKEND_URL}/api/callback`;

    // Create a preliminary order document in Firestore
    await db.collection("orders").doc(merchantOrderId).set({
        merchantOrderId, 
        userId,
        amount,
        products,
        shippingDetails,
        status: "PENDING",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // --- Using the builder EXACTLY as per the documentation ---
    const payRequest = StandardCheckoutPayRequest.builder()
        .merchantOrderId(merchantOrderId)
        .amount(amount * 100) // Amount in paise
        .redirectUrl(redirectUrl)
        .build();

    // Add other parameters to the object after building
    payRequest.callbackUrl = callbackUrl;
    payRequest.merchantUserId = userId;
    payRequest.mobileNumber = shippingDetails.phone;


    console.log("Initiating payment with SDK-built request:", payRequest);

    const response = await phonepeClient.pay(payRequest);
    
    // After getting the response, let's update our order with the official merchantTransactionId
    if (response.success && response.data.merchantTransactionId) {
        await db.collection("orders").doc(merchantOrderId).update({
            merchantTransactionId: response.data.merchantTransactionId,
        });
    }

    console.log("PhonePe API Response:", response);

    // --- FINAL FIX: Correctly read the redirectUrl from the SDK's response ---
    if (response && response.redirectUrl) {
        res.json({
            success: true,
            redirectUrl: response.redirectUrl,
            merchantOrderId: merchantOrderId,
        });
    } else {
        res.status(500).json({ success: false, message: response.message || "Could not get payment URL." });
    }
  } catch (error) {
    console.error("Error in /api/pay:", error);
    res.status(500).json({ success: false, message: "An error occurred while initiating payment." });
  }
});


/**
 * @route   POST /api/callback
 * @desc    PhonePe Server-to-Server Callback
 * @access  Public (from PhonePe servers)
 */
app.post("/api/callback", async (req, res) => {
    try {
        const callbackResponse = req.body;
        const xVerifyHeader = req.headers['x-verify'];

        if (!callbackResponse || !xVerifyHeader) {
            return res.status(400).send({ success: false, message: "Invalid callback" });
        }
        
        const decodedResponse = JSON.parse(Buffer.from(callbackResponse.response, 'base64').toString('utf8'));
        
        const merchantOrderId = decodedResponse.data.merchantOrderId;

        console.log(`Callback received for order: ${merchantOrderId}`, decodedResponse);
        
        const orderRef = db.collection("orders").doc(merchantOrderId);

        if (decodedResponse.success) {
            console.log(`Payment successful for ${merchantOrderId}. Updating status.`);
            await orderRef.update({
                status: "COMPLETED",
                phonepeTransactionId: decodedResponse.data.transactionId,
                paymentState: decodedResponse.code,
            });
        } else {
            console.log(`Payment failed for ${merchantOrderId}. Updating status.`);
            await orderRef.update({
                status: "FAILED",
                paymentState: decodedResponse.code,
            });
        }

        res.status(200).send();

    } catch (error) {
        console.error("Error in /api/callback:", error);
        res.status(500).send({ success: false, message: "Error processing callback." });
    }
});


/**
 * @route   GET /api/payment/status/:merchantOrderId
 * @desc    Check payment status from the frontend
 * @access  Public
 */
app.get("/api/payment/status/:merchantOrderId", async (req, res) => {
    const { merchantOrderId } = req.params;
    try {
        console.log(`Checking status for order: ${merchantOrderId}`);
        
        const orderDoc = await db.collection("orders").doc(merchantOrderId).get();

        if (!orderDoc.exists) {
            return res.status(404).json({ success: false, message: "Order not found." });
        }

        const orderData = orderDoc.data();

        if (orderData.status === "COMPLETED" || orderData.status === "FAILED") {
            return res.json({ success: true, status: orderData.status, order: orderData });
        }
        
        const merchantTransactionId = orderData.merchantTransactionId;
        if (!merchantTransactionId) {
             return res.status(400).json({ success: false, message: "Transaction ID not found for this order." });
        }

        const response = await phonepeClient.checkStatus(merchantTransactionId);

        console.log("PhonePe checkStatus API Response:", response);

        if (response.success) {
            let finalStatus = "PENDING";
            if (response.code === 'PAYMENT_SUCCESS') {
                finalStatus = "COMPLETED";
            } else if (['PAYMENT_ERROR', 'TIMED_OUT', 'TRANSACTION_NOT_FOUND'].includes(response.code)) {
                finalStatus = "FAILED";
            }

            await db.collection("orders").doc(merchantOrderId).update({
                status: finalStatus,
                paymentState: response.code
            });

            res.json({ success: true, status: finalStatus, order: { ...orderData, status: finalStatus } });

        } else {
            res.status(500).json({ success: false, message: "Failed to get status from PhonePe." });
        }

    } catch (error) {
        console.error(`Error checking status for ${merchantOrderId}:`, error);
        res.status(500).json({ success: false, message: "An error occurred while checking payment status." });
    }
});


app.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
