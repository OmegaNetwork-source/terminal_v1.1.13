const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const RPC_URL = "https://0x4e454228.rpc.aurora-cloud.dev"; // Omega RPC
const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY);
const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
const relayerSigner = relayerWallet.connect(provider);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };

// Alpha Vantage API proxy endpoints
const ALPHA_VANTAGE_API_KEY = 'Y4N6LC9U5OH8Q4MQ';
// Use existing fetch if present, otherwise require node-fetch
let fetch = global.fetch;
try {
  if (!fetch) {
    fetch = require('node-fetch');
  }
} catch (e) {
  // For Node 18+, fetch is global
}

const MINING_CONTRACT_ADDRESS = "0x54c731627f2d2b55267b53e604c869ab8e6a323b";
const MINING_CONTRACT_ABI = [
    "function mineBlock(uint256 nonce, bytes32 solution) external"
];

// Generate 30 wallets at startup and cycle through them for mining
const NUM_MINER_WALLETS = 1000;
const minerWallets = [];
let minerWalletIndex = 0;
const pendingTxs = {}; // Track pending tx per wallet
const busyWallets = {}; // Track busy wallets by address (timestamp when available)

for (let i = 0; i < NUM_MINER_WALLETS; i++) {
    const wallet = ethers.Wallet.createRandom();
    minerWallets.push(wallet);
}

// Helper to fund a wallet if needed
async function fundMinerWalletIfNeeded(wallet) {
    const balance = await provider.getBalance(wallet.address);
    if (balance.lt(ethers.utils.parseEther('0.0002'))) {
        const tx = await relayerSigner.sendTransaction({
            to: wallet.address,
            value: ethers.utils.parseEther('0.001')
        });
        await tx.wait();
        console.log(`Funded miner wallet ${wallet.address} with 0.001 OMEGA. Tx: ${tx.hash}`);
    }
}

// Helper to normalize address
function normAddress(address) {
    return address && typeof address === 'string' ? address.toLowerCase() : address;
}

app.post('/fund', async (req, res) => {
    const { address, amount } = req.body;
    if (!address || !ethers.utils.isAddress(address)) {
        return res.status(400).json({ error: 'Invalid address' });
    }
    const fundAmount = amount ? ethers.utils.parseEther(amount) : ethers.utils.parseEther('0.1'); // Default to 0.1 OMEGA
    try {
        const tx = await relayerSigner.sendTransaction({
            to: address,
            value: fundAmount
        });
        await tx.wait();
        console.log(`Funded ${address} with ${ethers.utils.formatEther(fundAmount)} OMEGA. Tx: ${tx.hash}`);
        res.json({ success: true, txHash: tx.hash });
    } catch (error) {
        console.error('Funding error:', error);
        res.status(500).json({ error: 'Funding failed', details: error.message });
    }
});

app.get('/status', async (req, res) => {
    try {
        const balance = await provider.getBalance(relayerWallet.address);
        res.json({
            relayerAddress: relayerWallet.address,
            balance: ethers.utils.formatEther(balance)
        });
    } catch (error) {
        res.status(500).json({ error: 'Failed to get status' });
    }
});

app.post('/ai', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ error: 'Prompt required' });
  try {
    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
      })
    });
    const data = await response.json();
    const answer = data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response from Gemini.';
    res.json({ answer });
  } catch (err) {
    res.status(500).json({ error: 'Gemini API error', details: err.message });
  }
});

// DexScreener trending
app.get('/dex/trending', async (req, res) => {
  try {
    const response = await fetch('https://api.dexscreener.com/token-profiles/latest/v1');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('DexScreener trending error:', err);
    res.status(500).json({ error: 'Failed to fetch trending tokens' });
  }
});

// DexScreener pair by chain and pairId
app.get('/dex/pair/:chainId/:pairId', async (req, res) => {
  try {
    const { chainId, pairId } = req.params;
    const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${chainId}/${pairId}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pair info' });
  }
});

// DexScreener pools
app.get('/dex/pools', async (req, res) => {
  try {
    const response = await fetch('https://api.dexscreener.com/latest/dex/pools');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

// DexScreener search
app.get('/dex/search', async (req, res) => {
  try {
    const q = req.query.q;
    const response = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search token' });
  }
});

app.get('/dex/pools/:chainId/:tokenAddress', async (req, res) => {
  try {
    const { chainId, tokenAddress } = req.params;
    const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/${chainId}/${tokenAddress}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

app.get('/gecko/search', async (req, res) => {
  try {
    const q = req.query.q;
    const response = await fetch(
      `https://api.geckoterminal.com/api/v2/search/pairs?query=${encodeURIComponent(q)}`,
      { headers: { Accept: 'application/json;version=20230302' } }
    );
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search GeckoTerminal' });
  }
});

app.get('/gecko/networks', async (req, res) => {
  try {
    const page = req.query.page ? `?page=${req.query.page}` : '';
    const response = await fetch(`${GECKO_API}/networks${page}`, { headers: GECKO_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch networks' });
  }
});

app.get('/gecko/networks/:network/dexes', async (req, res) => {
  try {
    const { network } = req.params;
    const response = await fetch(`${GECKO_API}/networks/${network}/dexes`, { headers: GECKO_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch dexes' });
  }
});

app.get('/gecko/networks/:network/pools', async (req, res) => {
  try {
    const { network } = req.params;
    const response = await fetch(`${GECKO_API}/networks/${network}/pools`, { headers: GECKO_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

app.get('/gecko/networks/:network/tokens/:address', async (req, res) => {
  try {
    const { network, address } = req.params;
    const response = await fetch(`${GECKO_API}/networks/${network}/tokens/${address}`, { headers: GECKO_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch token' });
  }
});

app.get('/gecko/networks/:network/tokens/:token_address/pools', async (req, res) => {
  try {
    const { network, token_address } = req.params;
    const response = await fetch(`${GECKO_API}/networks/${network}/tokens/${token_address}/pools`, { headers: GECKO_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch token pools' });
  }
});

app.get('/gecko/networks/:network/pools/:pool_address/info', async (req, res) => {
  try {
    const { network, pool_address } = req.params;
    const response = await fetch(`${GECKO_API}/networks/${network}/pools/${pool_address}/info`, { headers: GECKO_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pool info' });
  }
});

app.get('/gecko/networks/:network/pools/:pool_address/ohlcv/:timeframe', async (req, res) => {
  try {
    const { network, pool_address, timeframe } = req.params;
    const response = await fetch(`${GECKO_API}/networks/${network}/pools/${pool_address}/ohlcv/${timeframe}`, { headers: GECKO_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pool ohlcv' });
  }
});

app.get('/gecko/networks/:network/pools/:pool_address/trades', async (req, res) => {
  try {
    const { network, pool_address } = req.params;
    const params = new URLSearchParams(req.query).toString();
    const url = `${GECKO_API}/networks/${network}/pools/${pool_address}/trades${params ? '?' + params : ''}`;
    const response = await fetch(url, { headers: GECKO_HEADERS });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pool trades' });
  }
});

// Stock Quote
app.get('/stock/quote/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(symbol)}&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data["Global Quote"]) {
      const q = data["Global Quote"];
      res.json({
        price: q["05. price"],
        change: q["09. change"],
        changePercent: q["10. change percent"],
        ...q
      });
    } else {
      res.status(404).json({ error: 'No quote found' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Alpha Vantage error', details: err.message });
  }
});

// Stock Search
app.get('/stock/search/:query', async (req, res) => {
  try {
    const { query } = req.params;
    const url = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Alpha Vantage error', details: err.message });
  }
});

// Stock Daily
app.get('/stock/daily/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Alpha Vantage error', details: err.message });
  }
});

// Stock Overview
app.get('/stock/overview/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params;
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Alpha Vantage error', details: err.message });
  }
});

// Alpha Vantage US Inflation endpoint
app.get('/stock/inflation', async (req, res) => {
  try {
    const url = `https://www.alphavantage.co/query?function=INFLATION&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Alpha Vantage error', details: err.message });
  }
});

// Alpha Vantage US CPI endpoint
app.get('/stock/cpi', async (req, res) => {
  try {
    const url = `https://www.alphavantage.co/query?function=CPI&interval=monthly&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Alpha Vantage error', details: err.message });
  }
});

// Alpha Vantage US Real GDP endpoint
app.get('/stock/gdp', async (req, res) => {
  try {
    const url = `https://www.alphavantage.co/query?function=REAL_GDP&interval=annual&apikey=${ALPHA_VANTAGE_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Alpha Vantage error', details: err.message });
  }
});

// Track rewards per user address
const rewardsByAddress = {};

// Update /mine endpoint to require user address and credit rewards
app.post('/mine', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !ethers.utils.isAddress(address)) {
            return res.status(400).json({ error: 'User address required' });
        }
        const userAddr = normAddress(address);
        // Find a wallet with no pending tx and not busy
        let attempts = 0;
        let wallet = null;
        let now = Date.now();
        do {
            wallet = minerWallets[minerWalletIndex];
            minerWalletIndex = (minerWalletIndex + 1) % NUM_MINER_WALLETS;
            attempts++;
            if (!pendingTxs[wallet.address] && (!busyWallets[wallet.address] || busyWallets[wallet.address] < now)) break;
        } while (attempts < NUM_MINER_WALLETS);
        if (pendingTxs[wallet.address] || (busyWallets[wallet.address] && busyWallets[wallet.address] >= now)) {
            return res.status(429).json({ error: 'All mining wallets are busy, please try again in a moment.' });
        }
        const walletSigner = wallet.connect(provider);
        await fundMinerWalletIfNeeded(wallet);
        const contract = new ethers.Contract(MINING_CONTRACT_ADDRESS, MINING_CONTRACT_ABI, walletSigner);
        // Generate random nonce and solution
        const nonce = Math.floor(Math.random() * 1e12);
        const chars = '0123456789abcdef';
        let solution = '0x';
        for (let i = 0; i < 64; i++) {
            solution += chars[Math.floor(Math.random() * chars.length)];
        }
        const tx = await contract.mineBlock(nonce, solution, { gasLimit: 200000 });
        pendingTxs[wallet.address] = tx.hash;
        busyWallets[wallet.address] = Date.now() + 30000; // 30 seconds busy
        let reward = 0;
        const rand = Math.random();
        // Improved reward distribution for better multi-user experience
        if (rand < 0.25) reward = parseFloat((Math.random() * 0.003 + 0.001).toFixed(6)); // 25% chance for 0.001-0.004
        else if (rand < 0.35) reward = parseFloat((Math.random() * 0.002 + 0.0005).toFixed(6)); // 10% chance for 0.0005-0.0025
        else reward = 0; // 65% chance for no reward
        try {
            await tx.wait();
            // Only increment mining count and apply reward after successful tx
            if (!rewardsByAddress[userAddr]) rewardsByAddress[userAddr] = 0;
            if (!global.miningCounts) global.miningCounts = {};
            if (!global.miningCounts[userAddr]) global.miningCounts[userAddr] = 0;
            global.miningCounts[userAddr]++;
            rewardsByAddress[userAddr] += reward;
            console.log(`[MINE] ${userAddr} reward: ${reward}, total: ${rewardsByAddress[userAddr]}`);
        } finally {
            delete pendingTxs[wallet.address];
        }
        res.json({ success: true, txHash: tx.hash, nonce, solution, from: wallet.address, reward });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add /claim endpoint
app.post('/claim', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !ethers.utils.isAddress(address)) {
            return res.status(400).json({ error: 'User address required' });
        }
        const userAddr = normAddress(address);
        const reward = rewardsByAddress[userAddr] || 0;
        console.log(`[CLAIM] ${userAddr} claim: ${reward}`);
        if (reward <= 0) {
            return res.json({ success: false, message: 'No rewards to claim.' });
        }
        // Send OMEGA to user
        const tx = await relayerSigner.sendTransaction({
            to: address,
            value: ethers.utils.parseEther(reward.toString())
        });
        await tx.wait();
        rewardsByAddress[userAddr] = 0;
        res.json({ success: true, txHash: tx.hash, amount: reward });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Add /claimable endpoint
app.post('/claimable', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !ethers.utils.isAddress(address)) {
            return res.status(400).json({ error: 'User address required' });
        }
        const userAddr = normAddress(address);
        const amount = rewardsByAddress[userAddr] || 0;
        console.log(`[CLAIMABLE] ${userAddr} claimable: ${amount}`);
        if (amount > 0) {
            res.json({ success: true, amount });
        } else {
            res.json({ success: false, message: 'No claimable balance.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stress test endpoint: relayer sends 10 rapid empty txs
app.post('/stress', async (req, res) => {
    try {
        let txHashes = [];
        let promises = [];
        for (let i = 0; i < 10; i++) {
            const to = ethers.Wallet.createRandom().address;
            promises.push(
                relayerSigner.sendTransaction({
                    to,
                    value: 0,
                    gasLimit: 21000
                }).then(tx => {
                    txHashes.push(tx.hash);
                }).catch(e => {
                    txHashes.push('error:' + e.message);
                })
            );
        }
        await Promise.all(promises);
        res.json({ success: true, txHashes });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/jupiter/quote', async (req, res) => {
  const { inputMint, outputMint, amount } = req.body;
  console.log('Received Jupiter quote request:', { inputMint, outputMint, amount });
  if (!inputMint || !outputMint || !amount) {
    console.log('Missing parameters');
    return res.status(400).json({ error: 'inputMint, outputMint, and amount are required' });
  }
  try {
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}&slippageBps=50&restrictIntermediateTokens=true`;
    console.log('Jupiter quote URL:', url);
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    console.log('Jupiter response status:', response.status);
    const responseText = await response.text();
    console.log('Jupiter response text:', responseText);
    
    // Try to parse as JSON regardless of content-type header
    try {
      const data = JSON.parse(responseText);
      if (data.error || data.message) {
        // Jupiter returned an error
        console.log('Jupiter returned error:', data);
        res.status(400).json({ error: data.error || data.message || 'No swap route found for this pair and amount' });
      } else {
        // Jupiter returned a successful quote
        console.log('Jupiter quote success:', data);
        res.json(data);
      }
    } catch (parseError) {
      // Response is not valid JSON
      console.log('Jupiter non-JSON response:', responseText);
      res.status(400).json({ error: 'No swap route found for this pair and amount' });
    }
  } catch (err) {
    console.log('Jupiter quote error:', err);
    res.status(500).json({ error: 'Failed to fetch Jupiter quote', details: err.message });
  }
});

app.post('/jupiter/swap', async (req, res) => {
  const { inputMint, outputMint, amount, userPublicKey } = req.body;
  if (!inputMint || !outputMint || !amount || !userPublicKey) {
    return res.status(400).json({ error: 'inputMint, outputMint, amount, and userPublicKey are required' });
  }
  try {
    // 1. Get a quote with dynamic slippage and compute unit limit
    const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}&slippageBps=50&restrictIntermediateTokens=true&dynamicSlippage=true`;
    console.log('Getting Jupiter quote for swap:', quoteUrl);
    const quoteResponse = await fetch(quoteUrl, { headers: { 'Accept': 'application/json' } });
    const quoteText = await quoteResponse.text();
    console.log('Jupiter quote response:', quoteText);
    
    let quoteData;
    try {
      quoteData = JSON.parse(quoteText);
    } catch (parseError) {
      return res.status(400).json({ error: 'Failed to parse Jupiter quote response' });
    }
    
    if (!quoteData || !quoteData.outAmount || quoteData.error) {
      return res.status(400).json({ error: quoteData?.error || quoteData?.message || 'No swap route found for this pair and amount' });
    }

    // 2. Build the swap transaction with all recommended params
    const swapUrl = 'https://lite-api.jup.ag/swap/v1/swap';
    console.log('Building Jupiter swap transaction...');
    const swapResponse = await fetch(swapUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey,
        dynamicComputeUnitLimit: true,
        dynamicSlippage: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: 1000000,
            priorityLevel: "veryHigh"
          }
        }
      })
    });
    const swapText = await swapResponse.text();
    console.log('Jupiter swap response:', swapText);
    
    let swapData;
    try {
      swapData = JSON.parse(swapText);
    } catch (parseError) {
      return res.status(400).json({ error: 'Failed to parse Jupiter swap response' });
    }
    
    if (swapData && swapData.swapTransaction) {
      res.json({
        success: true,
        transaction: swapData.swapTransaction, // Ensure this is the base64 string
        outAmount: swapData.outAmount,
        inAmount: swapData.inAmount
      });
    } else {
      res.status(400).json({ error: 'Failed to create swap transaction', details: swapData });
    }
  } catch (err) {
    console.log('Jupiter swap error:', err);
    res.status(500).json({ error: 'Failed to create Jupiter swap', details: err.message });
  }
});

app.get('/jupiter/search', async (req, res) => {
  try {
    const q = req.query.q;
    const response = await fetch(`https://lite-api.jup.ag/tokens/v2/search?query=${encodeURIComponent(q)}`);
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to search Jupiter tokens' });
  }
});

app.listen(PORT, () => {
    console.log(`Relayer faucet listening on port ${PORT}`);
    console.log(`Relayer address: ${relayerWallet.address}`);
}); 
