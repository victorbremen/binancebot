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

app.post('/orden', async (req, res) => {
  try {
    const { symbol, price, take_profit, stop_loss } = req.body;

    // Obtener filtros de trading
    const exchangeInfo = await axios.get(`${BASE_URL}/api/v3/exchangeInfo?symbol=${symbol}`);
    const filters = exchangeInfo.data.symbols[0].filters;
    const lotSizeFilter = filters.find(f => f.filterType === 'LOT_SIZE');
    const stepSize = parseFloat(lotSizeFilter.stepSize);
    const minQty = parseFloat(lotSizeFilter.minQty);

    // Calcular cantidad
    const balanceUSDC = await getUSDCBalance();
    const qtyRaw = balanceUSDC / parseFloat(price);
    const quantity = (Math.floor(qtyRaw / stepSize) * stepSize).toFixed(8);

    if (parseFloat(quantity) < minQty) {
      return res.status(400).json({ success: false, error: 'Cantidad insuficiente para operar según LOT_SIZE' });
    }

    // Crear orden de compra
    const timestamp = Date.now();
    const buyParams = `symbol=${symbol}&side=BUY&type=LIMIT&timeInForce=GTC&quantity=${quantity}&price=${price}&recvWindow=60000&timestamp=${timestamp}`;
    const buySignature = sign(buyParams);

    const buyOrder = await axios.post(`${BASE_URL}/api/v3/order?${buyParams}&signature=${buySignature}`, null, {
      headers: { 'X-MBX-APIKEY': API_KEY },
    });

    const orderId = buyOrder.data.orderId;

    // Esperar hasta que se ejecute
    let executed = false;
    while (!executed) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const checkParams = `symbol=${symbol}&orderId=${orderId}&timestamp=${Date.now()}`;
      const checkSignature = sign(checkParams);
      const result = await axios.get(`${BASE_URL}/api/v3/order?${checkParams}&signature=${checkSignature}`, {
        headers: { 'X-MBX-APIKEY': API_KEY },
      });
      if (result.data.status === 'FILLED') {
        executed = true;
      }
    }

    // Crear orden OCO
    const ocoParams = `symbol=${symbol}&side=SELL&quantity=${quantity}&price=${take_profit}&stopPrice=${stop_loss}&stopLimitPrice=${stop_loss}&stopLimitTimeInForce=GTC&timestamp=${Date.now()}`;
    const ocoSignature = sign(ocoParams);

    await axios.post(`${BASE_URL}/api/v3/order/oco?${ocoParams}&signature=${ocoSignature}`, null, {
      headers: { 'X-MBX-APIKEY': API_KEY },
    });

    res.json({ success: true, message: 'Orden de compra ejecutada y OCO colocada (TP y SL)' });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.response?.data || err.message });
  }
});

app.listen(3000, () => {
  console.log('Servidor corriendo en puerto 3000');
});
