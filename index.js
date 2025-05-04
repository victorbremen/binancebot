require('dotenv').config();
const express = require('express');
const axios = require('axios');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE_URL = 'https://api.binance.com';

function sign(queryString) {
  return crypto.createHmac('sha256', API_SECRET).update(queryString).digest('hex');
}

async function getUSDCBalance() {
  const timestamp = Date.now();
  const query = `timestamp=${timestamp}`;
  const signature = sign(query);

  const response = await axios.get(`${BASE_URL}/api/v3/account?${query}&signature=${signature}`, {
    headers: { 'X-MBX-APIKEY': API_KEY },
  });

  const usdc = response.data.balances.find(b => b.asset === 'USDC');
  return parseFloat(usdc?.free || 0);
}

function ajustarCantidad(cantidad, stepSize) {
  return (Math.floor(cantidad / stepSize) * stepSize).toFixed(8);
}

app.post('/orden', async (req, res) => {
  try {
    const { symbol, take_profit, stop_loss } = req.body;

    const exchangeInfo = await axios.get(`${BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`);
    const filters = exchangeInfo.data.symbols[0].filters;
    const lotSizeFilter = filters.find(f => f.filterType === 'LOT_SIZE');
    const stepSize = parseFloat(lotSizeFilter.stepSize);
    const minQty = parseFloat(lotSizeFilter.minQty);

    const balanceUSDC = await getUSDCBalance();
    const priceTicker = await axios.get(`${BASE_URL}/api/v3/ticker/price?symbol=${symbol}`);
    const marketPrice = parseFloat(priceTicker.data.price);

    const qtyRaw = balanceUSDC / marketPrice;
    const quantityFull = Math.floor(qtyRaw / stepSize) * stepSize;
    const quantityBuy = ajustarCantidad(quantityFull, stepSize);
    const quantitySell = ajustarCantidad(quantityFull / 2, stepSize); // TP y SL cada uno con la mitad

    if (parseFloat(quantityBuy) < minQty || parseFloat(quantitySell) < minQty) {
      return res.status(400).json({
        success: false,
        error: 'Cantidad insuficiente según LOT_SIZE',
        details: {
          balanceUSDC,
          marketPrice,
          qtyRaw,
          stepSize,
          minQty,
          quantityBuy,
          quantitySell
        }
      });
    }

    const timestamp = Date.now();

    // Orden de compra a mercado
    const buyParams = `symbol=${symbol}&side=BUY&type=MARKET&quoteOrderQty=${balanceUSDC}&recvWindow=60000&timestamp=${timestamp}`;
    const buySignature = sign(buyParams);
    const buyResponse = await axios.post(`${BASE_URL}/api/v3/order?${buyParams}&signature=${buySignature}`, null, {
      headers: { 'X-MBX-APIKEY': API_KEY },
    });

    // TP
    const tpParams = `symbol=${symbol}&side=SELL&type=LIMIT&timeInForce=GTC&quantity=${quantitySell}&price=${take_profit}&recvWindow=60000&timestamp=${Date.now()}`;
    const tpSignature = sign(tpParams);
    await axios.post(`${BASE_URL}/api/v3/order?${tpParams}&signature=${tpSignature}`, null, {
      headers: { 'X-MBX-APIKEY': API_KEY },
    });

    // SL
    const slParams = `symbol=${symbol}&side=SELL&type=STOP_LOSS_LIMIT&quantity=${quantitySell}&price=${stop_loss}&stopPrice=${stop_loss}&timeInForce=GTC&recvWindow=60000&timestamp=${Date.now()}`;
    const slSignature = sign(slParams);
    await axios.post(`${BASE_URL}/api/v3/order?${slParams}&signature=${slSignature}`, null, {
      headers: { 'X-MBX-APIKEY': API_KEY },
    });

    res.json({ success: true, message: 'Orden MARKET ejecutada y TP/SL colocados correctamente' });
  } catch (err) {
    console.error('❌ ERROR:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.listen(3000, () => {
  console.log('🚀 Servidor corriendo en puerto 3000');
});
