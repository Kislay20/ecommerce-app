// backend/server.js

const express = require("express");
const cors = require("cors");
const {
  StandardCheckoutClient,
  Env,
  StandardCheckoutPayRequest,
} = require("pg-sdk-node");
const { randomUUID } = require("crypto");
const admin = require("firebase-admin");

// --- CONFIGURATION ---
// Load environment variables from a .env file
require("dotenv").config();

const PORT = process.env.PORT || 5000;
const isProduction = process.env.NODE_ENV === "production";

// --- PhonePe Credentials (Loaded from .env) ---
const PHONEPE_CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const PHONEPE_CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const PHONEPE_CLIENT_VERSION = 1; // As per docs
const MERCHANT_ID = process.env.MERCHANT_ID;

// --- Environment-specific URLs (Loaded from .env) ---
const BACKEND_URL = isProduction
  ? process.env.PROD_BACKEND_URL
  : process.env.DEV_BACKEND_URL;
const FRONTEND_URL = isProduction
  ? process.env.PROD_FRONTEND_URL
  : process.env.DEV_FRONTEND_URL;

// --- Securely initialize Firebase Admin SDK for both environments ---
let serviceAccount;
if (isProduction) {
  // On a hosting service like Render, parse the service account from the environment variable
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  } else {
    console.error(
      "FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set for production."
    );
    process.exit(1);
  }
} else {
  // For local development, load from the file
  serviceAccount = require("./firebase-service-account.json");
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

// --- INITIALIZATION ---
const app = express();
app.use(cors());
app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

// --- Initialize PhonePe client based on the environment ---
// const phonepeEnv = isProduction ? Env.PRODUCTION : Env.SANDBOX; // Use PRODUCTION for live, SANDBOX for testing
// Force sandbox mode for the presentation, regardless of NODE_ENV
const phonepeEnv = Env.SANDBOX;
const phonepeClient = StandardCheckoutClient.getInstance(
  PHONEPE_CLIENT_ID,
  PHONEPE_CLIENT_SECRET,
  PHONEPE_CLIENT_VERSION,
  phonepeEnv
);

console.log(
  `--- Server starting in ${
    isProduction ? "PRODUCTION" : "DEVELOPMENT"
  } mode ---`
);
console.log("MERCHANT_ID:", MERCHANT_ID);
console.log("PHONEPE_CLIENT_ID:", PHONEPE_CLIENT_ID);
console.log("PHONEPE_ENV:", phonepeEnv);
console.log("---------------------------------");

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
      return res
        .status(400)
        .json({ success: false, message: "Missing required payment data." });
    }

    const merchantOrderId = `M-${randomUUID().slice(0, 6)}`;

    const redirectUrl = `${FRONTEND_URL}/payment-status/${merchantOrderId}`;
    const callbackUrl = `${BACKEND_URL}/api/callback`;

    // Create initial order in Firestore
    await db.collection("orders").doc(merchantOrderId).set({
      merchantOrderId,
      userId,
      amount,
      products,
      shippingDetails,
      status: "PENDING",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const payRequest = StandardCheckoutPayRequest.builder()
      .merchantOrderId(merchantOrderId)
      .amount(amount * 100) // amount in paise
      .redirectUrl(redirectUrl)
      .build();

    payRequest.callbackUrl = callbackUrl;
    payRequest.merchantUserId = userId;
    payRequest.mobileNumber = shippingDetails.phone;

    const response = await phonepeClient.pay(payRequest);

    console.log("PhonePe API Response:", response);

    // ✅ Save PhonePe's actual orderId as merchantTransactionId
    if (response && response.orderId) {
      await db.collection("orders").doc(merchantOrderId).update({
        merchantTransactionId: response.orderId,
      });
    }

    if (response && response.redirectUrl) {
      res.json({
        success: true,
        redirectUrl: response.redirectUrl,
        merchantOrderId,
      });
    } else {
      res.status(500).json({
        success: false,
        message: response.message || "Could not get payment URL.",
      });
    }
  } catch (error) {
    console.error("Error in /api/pay:", error);
    res.status(500).json({
      success: false,
      message: "An error occurred while initiating payment.",
    });
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
    const xVerifyHeader = req.headers["x-verify"];

    if (!callbackResponse || !xVerifyHeader) {
      return res
        .status(400)
        .send({ success: false, message: "Invalid callback" });
    }

    const decodedResponse = JSON.parse(
      Buffer.from(callbackResponse.response, "base64").toString("utf8")
    );

    const merchantOrderId = decodedResponse.data.merchantOrderId;

    console.log(
      `Callback received for order: ${merchantOrderId}`,
      decodedResponse
    );

    const orderRef = db.collection("orders").doc(merchantOrderId);

    if (decodedResponse.success) {
      console.log(
        `Payment successful for ${merchantOrderId}. Updating status.`
      );
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
    console.log("Received PhonePe callback ✅");
    console.log("Headers:", req.headers);
    console.log("Body:", req.body);
  } catch (error) {
    console.error("Error in /api/callback:", error);
    res
      .status(500)
      .send({ success: false, message: "Error processing callback." });
  }
});


/**
 * @route   GET /api/payment/status/:merchantOrderId
 * @desc    Check payment status using the PhonePe SDK
 * @access  Public
 */
app.get("/api/payment/status/:merchantOrderId", async (req, res) => {
  const { merchantOrderId } = req.params;

  if (!merchantOrderId) {
    return res
      .status(400)
      .json({ success: false, message: "Merchant Order ID is required." });
  }

  try {
    console.log(`Checking status for order: ${merchantOrderId}`);

    const statusResponse = await phonepeClient.getOrderStatus(merchantOrderId);

    console.log("✅ PhonePe SDK Status Response:", statusResponse);

    // ✅ CORRECTED a condition to check for a valid response state
    if (statusResponse && statusResponse.state) {
      const paymentState = statusResponse.state; // 'COMPLETED', 'FAILED', 'PENDING'
      let finalStatus = paymentState; // Directly use the state from the response

      // Update your Firestore database
      const orderRef = db.collection("orders").doc(merchantOrderId);
      await orderRef.update({
        status: finalStatus,
        paymentState: paymentState,
        phonepeTransactionId: statusResponse.paymentDetails?.[0]?.transactionId || null,
      });
      console.log(`Updated Firestore status for ${merchantOrderId} to ${finalStatus}`);
      
      const updatedOrderData = (await orderRef.get()).data();

      return res.json({ 
        success: true, 
        status: finalStatus, 
        order: updatedOrderData 
      });

    } else {
      // This block will now correctly handle cases where the SDK truly fails
      return res.status(500).json({
        success: false,
        message: statusResponse.message || "Failed to retrieve payment status.",
      });
    }
  } catch (error) {
    console.error("Final status check error:", error.message);
    return res.status(500).json({
      success: false,
      message: "Error during final status check.",
    });
  }
});



// backend/server.js

/**
 * @route   GET /api/orders/:userId
 * @desc    Get all orders for a specific user
 * @access  Public (or Protected if you have auth)
 */
app.get("/api/orders/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const orders = [];

    // Query the 'orders' collection where the 'userId' field matches
    const snapshot = await db
      .collection("orders")
      .where("userId", "==", userId)
      .orderBy("createdAt", "desc") // Show newest orders first
      .get();

    if (snapshot.empty) {
      return res.json({ success: true, orders: [] });
    }

    snapshot.forEach((doc) => {
      orders.push({ id: doc.id, ...doc.data() });
    });

    res.json({ success: true, orders });
  } catch (error) {
    console.error("Error fetching orders:", error);
    res.status(500).json({ success: false, message: "Error fetching orders." });
  }
});


app.listen(PORT, () => {
  console.log(
    `Server is listening on port ${PORT} in ${
      process.env.NODE_ENV || "development"
    } mode.`
  );
});
