const express = require('express');
const { ethers } = require('ethers');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

// 🔧 NETWORK RETRY CONFIGURATION (Fixes ETIMEDOUT/ENETUNREACH errors)
const NETWORK_RETRY_CONFIG = {
    maxRetries: 5,
    baseDelay: 1000,  // 1 second
    maxDelay: 10000,  // 10 seconds
    timeoutMs: 30000  // 30 seconds per attempt
};

// 🌐 RPC ENDPOINTS (Only the one you actually have)
const RPC_ENDPOINTS = [
    "https://0x4e454228.rpc.aurora-cloud.dev"
];

let currentRpcIndex = 0;
let provider = null;
let relayerSigner = null;

// 🔄 NETWORK RETRY WRAPPER (Handles your specific errors)
async function withNetworkRetry(operation, context = 'operation') {
    let lastError;
    
    for (let attempt = 1; attempt <= NETWORK_RETRY_CONFIG.maxRetries; attempt++) {
        try {
            console.log(`[NETWORK] ${context} - Attempt ${attempt}/${NETWORK_RETRY_CONFIG.maxRetries}`);
            
            // Set timeout for this attempt
            const timeoutPromise = new Promise((_, reject) => 
                setTimeout(() => reject(new Error('Network timeout')), NETWORK_RETRY_CONFIG.timeoutMs)
            );
            
            const result = await Promise.race([operation(), timeoutPromise]);
            
            console.log(`[NETWORK] ${context} - Success on attempt ${attempt}`);
            return result;
            
        } catch (error) {
            lastError = error;
            const isNetworkError = 
                error.code === 'ETIMEDOUT' || 
                error.code === 'ENETUNREACH' ||
                error.code === 'ECONNREFUSED' ||
                error.code === 'ENOTFOUND' ||
                error.message.includes('timeout') ||
                error.message.includes('network') ||
                error.message.includes('connect');
            
            console.log(`[NETWORK] ${context} - Attempt ${attempt} failed: ${error.message}`);
            
            if (!isNetworkError && attempt === 1) {
                // Non-network error, fail fast
                throw error;
            }
            
            if (attempt < NETWORK_RETRY_CONFIG.maxRetries) {
                // Exponential backoff with jitter
                const delay = Math.min(
                    NETWORK_RETRY_CONFIG.baseDelay * Math.pow(2, attempt - 1),
                    NETWORK_RETRY_CONFIG.maxDelay
                ) + Math.random() * 1000;
                
                console.log(`[NETWORK] ${context} - Retrying in ${Math.round(delay)}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    
    console.error(`[NETWORK] ${context} - All ${NETWORK_RETRY_CONFIG.maxRetries} attempts failed`);
    throw lastError;
}

// 🚀 INITIALIZE RPC WITH RETRY
async function initializeProvider() {
    const rpcUrl = RPC_ENDPOINTS[currentRpcIndex];
    console.log(`[RPC] Initializing connection to: ${rpcUrl}`);
    
    await withNetworkRetry(async () => {
        const testProvider = new ethers.providers.JsonRpcProvider(rpcUrl);
        
        // Test connection
        const blockNumber = await testProvider.getBlockNumber();
        console.log(`[RPC] ✅ Connected - Block: ${blockNumber}`);
        
        provider = testProvider;
        const relayerWallet = new ethers.Wallet(process.env.RELAYER_PRIVATE_KEY);
        relayerSigner = relayerWallet.connect(provider);
        
        console.log(`[RPC] ✅ Relayer address: ${relayerWallet.address}`);
        return true;
    }, 'RPC Connection');
}

// All the constants and setup from your original relayer
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;

const GECKO_API = 'https://api.geckoterminal.com/api/v2';
const GECKO_HEADERS = { Accept: 'application/json;version=20230302' };

const ALPHA_VANTAGE_API_KEY = 'Y4N6LC9U5OH8Q4MQ';
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

// Generate mining wallets
const NUM_MINER_WALLETS = 1000;
const minerWallets = [];
let minerWalletIndex = 0;
const pendingTxs = {};
const busyWallets = {};

for (let i = 0; i < NUM_MINER_WALLETS; i++) {
    const wallet = ethers.Wallet.createRandom();
    minerWallets.push(wallet);
}

// Helper functions
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

function normAddress(address) {
    return address && typeof address === 'string' ? address.toLowerCase() : address;
}

// Track rewards per user address
const rewardsByAddress = {};

// 🛡️ NETWORK-RESILIENT /fund ENDPOINT
app.post('/fund', async (req, res) => {
    const { address, amount } = req.body;
    if (!address || !ethers.utils.isAddress(address)) {
        return res.status(400).json({ error: 'Invalid address' });
    }
    
    const fundAmount = amount ? ethers.utils.parseEther(amount) : ethers.utils.parseEther('0.1');
    const startTime = Date.now();
    
    try {
        console.log(`[FUND] 🚀 Starting: ${address} - ${ethers.utils.formatEther(fundAmount)} OMEGA`);
        
        const result = await withNetworkRetry(async () => {
            // Get gas price with retry
            const gasPrice = await withNetworkRetry(async () => {
                try {
                    const networkGasPrice = await provider.getGasPrice();
                    return networkGasPrice.mul(120).div(100); // 20% bump
                } catch (error) {
                    console.log(`[GAS] Using fallback gas price: ${error.message}`);
                    return ethers.utils.parseUnits('30', 'gwei');
                }
            }, 'Gas Price Fetch');
            
            // Send transaction
            const tx = await relayerSigner.sendTransaction({
                to: address,
                value: fundAmount,
                gasLimit: 21000,
                gasPrice: gasPrice
            });
            
            return tx;
        }, 'Fund Transaction');
        
        const responseTime = Date.now() - startTime;
        console.log(`[FUND] ✅ Success: ${result.hash} (${responseTime}ms)`);
        
        res.json({ 
            success: true, 
            txHash: result.hash,
            responseTime: responseTime
        });
        
        // Background confirmation
        result.wait(1).then(receipt => {
            console.log(`[FUND] ✅ Confirmed: ${result.hash} - Block: ${receipt.blockNumber}`);
        }).catch(err => {
            console.log(`[FUND] ⚠️  Confirmation failed: ${result.hash} - ${err.message}`);
        });
        
    } catch (error) {
        const responseTime = Date.now() - startTime;
        console.error(`[FUND] ❌ Failed after retries: ${error.message} (${responseTime}ms)`);
        
        res.status(500).json({ 
            error: 'Network connectivity issues',
            details: 'Render.com network problems with Aurora Cloud RPC',
            suggestion: 'Try again in a few minutes',
            responseTime: responseTime
        });
    }
});

// Status endpoint
app.get('/status', async (req, res) => {
    try {
        const result = await withNetworkRetry(async () => {
            const balance = await provider.getBalance(relayerSigner.address);
            const blockNumber = await provider.getBlockNumber();
            
            return {
                relayerAddress: relayerSigner.address,
                balance: ethers.utils.formatEther(balance),
                blockNumber: blockNumber
            };
        }, 'Status Check');
        
        res.json({
            ...result,
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            networkRetryEnabled: true
        });
        
    } catch (error) {
        res.status(500).json({ 
            error: 'Failed to get status',
            details: error.message 
        });
    }
});

// AI endpoint
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

// DexScreener endpoints
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

app.get('/dex/pools', async (req, res) => {
  try {
    const response = await fetch('https://api.dexscreener.com/latest/dex/pools');
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch pools' });
  }
});

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

// GeckoTerminal endpoints
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

// Stock/Alpha Vantage endpoints
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

// 🛡️ NETWORK-RESILIENT /mine ENDPOINT
app.post('/mine', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !ethers.utils.isAddress(address)) {
            return res.status(400).json({ error: 'User address required' });
        }
        const userAddr = normAddress(address);
        
        const result = await withNetworkRetry(async () => {
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
                throw new Error('All mining wallets are busy, please try again in a moment.');
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
            
            return { tx, nonce, solution, wallet: wallet.address };
        }, 'Mining Transaction');
        
        let reward = 0;
        const rand = Math.random();
        // Improved reward distribution for better multi-user experience
        if (rand < 0.25) reward = parseFloat((Math.random() * 0.003 + 0.001).toFixed(6)); // 25% chance for 0.001-0.004
        else if (rand < 0.35) reward = parseFloat((Math.random() * 0.002 + 0.0005).toFixed(6)); // 10% chance for 0.0005-0.0025
        else reward = 0; // 65% chance for no reward
        
        res.json({ 
            success: true, 
            txHash: result.tx.hash, 
            nonce: result.nonce, 
            solution: result.solution, 
            from: result.wallet, 
            reward: reward 
        });
        
        // Background processing
        result.tx.wait().then(() => {
            if (!rewardsByAddress[userAddr]) rewardsByAddress[userAddr] = 0;
            if (!global.miningCounts) global.miningCounts = {};
            if (!global.miningCounts[userAddr]) global.miningCounts[userAddr] = 0;
            global.miningCounts[userAddr]++;
            rewardsByAddress[userAddr] += reward;
            console.log(`[MINE] ${userAddr} reward: ${reward}, total: ${rewardsByAddress[userAddr]}`);
        }).finally(() => {
            delete pendingTxs[result.wallet];
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Claim endpoint
app.post('/claim', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !ethers.utils.isAddress(address)) {
            return res.status(400).json({ error: 'User address required' });
        }
        const userAddr = normAddress(address);
        const reward = rewardsByAddress[userAddr] || 0;
        
        if (reward <= 0) {
            return res.json({ success: false, message: 'No rewards to claim.' });
        }
        
        const result = await withNetworkRetry(async () => {
            const tx = await relayerSigner.sendTransaction({
                to: address,
                value: ethers.utils.parseEther(reward.toString())
            });
            await tx.wait();
            return tx;
        }, 'Claim Transaction');
        
        rewardsByAddress[userAddr] = 0;
        res.json({ success: true, txHash: result.hash, amount: reward });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Claimable endpoint
app.post('/claimable', async (req, res) => {
    try {
        const { address } = req.body;
        if (!address || !ethers.utils.isAddress(address)) {
            return res.status(400).json({ error: 'User address required' });
        }
        const userAddr = normAddress(address);
        const amount = rewardsByAddress[userAddr] || 0;
        
        if (amount > 0) {
            res.json({ success: true, amount });
        } else {
            res.json({ success: false, message: 'No claimable balance.' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stress test endpoint
app.post('/stress', async (req, res) => {
    try {
        let txHashes = [];
        let promises = [];
        for (let i = 0; i < 10; i++) {
            const to = ethers.Wallet.createRandom().address;
            promises.push(
                withNetworkRetry(async () => {
                    return await relayerSigner.sendTransaction({
                        to,
                        value: 0,
                        gasLimit: 21000
                    });
                }, `Stress Test ${i+1}`).then(tx => {
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

// Jupiter endpoints
app.post('/jupiter/quote', async (req, res) => {
  const { inputMint, outputMint, amount } = req.body;
  if (!inputMint || !outputMint || !amount) {
    return res.status(400).json({ error: 'inputMint, outputMint, and amount are required' });
  }
  try {
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}&slippageBps=50&restrictIntermediateTokens=true`;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const responseText = await response.text();
    
    try {
      const data = JSON.parse(responseText);
      if (data.error || data.message) {
        res.status(400).json({ error: data.error || data.message || 'No swap route found for this pair and amount' });
      } else {
        res.json(data);
      }
    } catch (parseError) {
      res.status(400).json({ error: 'No swap route found for this pair and amount' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch Jupiter quote', details: err.message });
  }
});

app.post('/jupiter/swap', async (req, res) => {
  const { inputMint, outputMint, amount, userPublicKey } = req.body;
  if (!inputMint || !outputMint || !amount || !userPublicKey) {
    return res.status(400).json({ error: 'inputMint, outputMint, amount, and userPublicKey are required' });
  }
  try {
    const quoteUrl = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${encodeURIComponent(inputMint)}&outputMint=${encodeURIComponent(outputMint)}&amount=${encodeURIComponent(amount)}&slippageBps=50&restrictIntermediateTokens=true&dynamicSlippage=true`;
    const quoteResponse = await fetch(quoteUrl, { headers: { 'Accept': 'application/json' } });
    const quoteText = await quoteResponse.text();
    
    let quoteData;
    try {
      quoteData = JSON.parse(quoteText);
    } catch (parseError) {
      return res.status(400).json({ error: 'Failed to parse Jupiter quote response' });
    }
    
    if (!quoteData || !quoteData.outAmount || quoteData.error) {
      return res.status(400).json({ error: quoteData?.error || quoteData?.message || 'No swap route found for this pair and amount' });
    }

    const swapUrl = 'https://lite-api.jup.ag/swap/v1/swap';
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
    
    let swapData;
    try {
      swapData = JSON.parse(swapText);
    } catch (parseError) {
      return res.status(400).json({ error: 'Failed to parse Jupiter swap response' });
    }
    
    if (swapData && swapData.swapTransaction) {
      res.json({
        success: true,
        transaction: swapData.swapTransaction,
        outAmount: swapData.outAmount,
        inAmount: swapData.inAmount
      });
    } else {
      res.status(400).json({ error: 'Failed to create swap transaction', details: swapData });
    }
  } catch (err) {
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

// Initialize and start server
async function startServer() {
    try {
        console.log('🚀 INITIALIZING NETWORK-RESILIENT RELAYER...');
        console.log('🔧 Network retry enabled for ETIMEDOUT/ENETUNREACH errors');
        
        if (!process.env.RELAYER_PRIVATE_KEY) {
            throw new Error('RELAYER_PRIVATE_KEY not found in environment variables');
        }
        
        await initializeProvider();
        
        app.listen(PORT, () => {
            console.log(`🚀 RELAYER RUNNING ON PORT ${PORT}`);
            console.log(`🏠 Relayer address: ${relayerSigner.address}`);
            console.log(`⏰ Started at: ${new Date().toISOString()}`);
            console.log(`🌐 RPC: ${RPC_ENDPOINTS[currentRpcIndex]}`);
            console.log(`🛡️  Network retry: ${NETWORK_RETRY_CONFIG.maxRetries} attempts, ${NETWORK_RETRY_CONFIG.timeoutMs/1000}s timeout`);
        });
        
    } catch (error) {
        console.error('❌ CRITICAL: Failed to start relayer:', error);
        console.error('💡 Check your RELAYER_PRIVATE_KEY and network connection');
        process.exit(1);
    }
}

startServer(); 
