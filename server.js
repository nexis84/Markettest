const tmi = require('tmi.js');
const axios = require('axios');
const Bottleneck = require('bottleneck');
const express = require('express');

// Set up Express server for Cloud Run
const app = express();

// Set up rate limiter for external APIs (ESI, Fuzzwork, EveRef)
const apiLimiter = new Bottleneck({
    minTime: 500, // 500ms between external API requests (2 request per second)
    maxConcurrent: 1 // Only one external API request at a time
});

// Set up rate limiter for sending Twitch chat messages
const chatLimiter = new Bottleneck({
    minTime: 1500, // Limit to 1 message every 1.5 seconds (Adjust as needed for Twitch limits)
    maxConcurrent: 1
});

// Ensure OAuth Token is properly set
if (!process.env.TWITCH_OAUTH_TOKEN) {
    console.error("Missing TWITCH_OAUTH_TOKEN. Check your environment variables.");
    process.exit(1);
}

// Twitch Bot Configuration
const client = new tmi.Client({
    options: { debug: false }, // <--- DISABLED TMI.JS DEBUG LOGGING to reduce chat message logs --->
    identity: {
        username: 'Eve_twitch_market_bot',
        password: process.env.TWITCH_OAUTH_TOKEN // Ensure this includes 'chat:read' and 'chat:edit' scopes
    },
    channels: ['ne_x_is', 'contempoenterprises'] // Channels the bot should join
});

// Set a default User Agent if one is not set in the environment variables.
const USER_AGENT = process.env.USER_AGENT || 'EveTwitchMarketBot/1.5.0 (Contact: YourEmailOrDiscord)'; // Customize this

// Caches
const typeIDCache = new Map();
const corpIDCache = new Map(); // <-- NEW: Cache for Corporation IDs
const manufacturingCache = new Map(); // Cache for product manufacturing data

const JITA_SYSTEM_ID = 30000142; // Jita system ID
const JITA_REGION_ID = 10000002; // The Forge Region ID
const PLEX_TYPE_ID = 44992; // Correct Type ID for PLEX
const GLOBAL_PLEX_REGION_ID = 19000001; // New Global PLEX Market Region ID

// Maps for Type ID and Name lookups from eve-files.com
const eveFilesTypeIDMap = new Map(); // Maps lowercase name -> typeID
const eveFilesIDToNameMap = new Map(); // Maps typeID -> proper name
let isEveFilesTypeIDMapLoaded = false;

/**
 * Loads Type IDs and Names from eve-files.com into in-memory maps.
 * Creates both a name->ID map and an ID->name map for efficient lookups.
 */
async function loadEveFilesTypeIDs() {
    console.log('[loadEveFilesTypeIDs] Starting to load Type IDs from eve-files.com...');
    const typeIdFileUrl = 'https://eve-files.com/chribba/typeid.txt';
    try {
        const response = await axios.get(typeIdFileUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 30000
        });

        const lines = response.data.split('\n');
        lines.forEach(line => {
            const parts = line.trim().split(' ');
            if (parts.length >= 2) {
                const typeID = parseInt(parts[0], 10);
                const itemName = parts.slice(1).join(' ').trim();
                if (!isNaN(typeID) && itemName) {
                    eveFilesTypeIDMap.set(itemName.toLowerCase(), typeID);
                    eveFilesIDToNameMap.set(typeID, itemName); // Populate the reverse map
                }
            }
        });
        isEveFilesTypeIDMapLoaded = true;
        console.log(`[loadEveFilesTypeIDs] Successfully loaded ${eveFilesTypeIDMap.size} Type IDs and ${eveFilesIDToNameMap.size} ID->Name pairs.`);
    } catch (error) {
        console.error(`[loadEveFilesTypeIDs] Error loading Type IDs from ${typeIdFileUrl}:`, error.message);
    }
}

// --- TMI Event Listeners ---
client.on('connected', (addr, port) => {
    console.log(`* Connected to Twitch chat (${addr}:${port}). State: ${client.readyState()}`);
    if (client.opts.channels && client.opts.channels.length > 0) {
        const testChannel = client.opts.channels[0];
        chatLimiter.schedule(() => {
            console.log(`Attempting initial connection message to ${testChannel}`);
            return client.say(testChannel, 'Eve_twitch_market_bot connected and ready!')
                .then(() => console.log(`Sent connection confirmation to ${testChannel}`))
                .catch(err => console.error(`>>>> FAILED to send connection confirmation to ${testChannel}:`, err));
        });
    }
});
client.on('disconnected', (reason) => console.error(`Twitch client disconnected: ${reason}. State: ${client.readyState()}`));
client.on('error', (err) => console.error('>>>>>> Twitch client library error:', err));
// --- End TMI Event Listeners ---

loadEveFilesTypeIDs().then(() => {
    client.connect()
        .then(() => console.log("Twitch client connection initiated."))
        .catch(error => {
            console.error(">>>>>> Twitch client failed to connect:", error);
            process.exit(1);
        });
});

async function safeSay(channel, message) {
    return chatLimiter.schedule(() => {
        console.log(`[safeSay] Attempting to send to ${channel}: "${message.substring(0, 50)}..."`);
        return client.say(channel, message)
            .then(() => console.log(`[safeSay] Message supposedly sent successfully to ${channel}.`))
            .catch(err => console.error(`[safeSay] >>>>> ERROR sending message to ${channel}:`, err));
    });
}

function getTypeNameByID(typeID) {
    return eveFilesIDToNameMap.get(typeID) || `Item (ID: ${typeID})`;
}

async function fetchMarketData(itemName, typeID, channel, quantity = 1) {
    try {
        console.log(`[fetchMarketData] Start: Fetching market data for ${itemName} (TypeID: ${typeID}), Quantity: ${quantity}`);
        await fetchMarketDataFromESI(itemName, typeID, channel, quantity);
    } catch (error) {
        console.error(`[fetchMarketData] General Error caught for "${itemName}": ${error.message}`);
        await safeSay(channel, `❌ Error fetching data for "${itemName}": ${error.message} ❌`);
    }
}

async function fetchMarketDataFromESI(itemName, typeID, channel, quantity = 1, retryCount = 0) {
    try {
        console.log(`[fetchMarketDataFromESI] Start ESI Call: Fetching for ${itemName} (TypeID: ${typeID}), Quantity: ${quantity}, Retry: ${retryCount}`);
        const isPlex = (typeID === PLEX_TYPE_ID);
        const targetRegionId = isPlex ? GLOBAL_PLEX_REGION_ID : JITA_REGION_ID;

        const sellOrdersURL = `https://esi.evetech.net/latest/markets/${targetRegionId}/orders/?datasource=tranquility&order_type=sell&type_id=${typeID}`;
        const buyOrdersURL = `https://esi.evetech.net/latest/markets/${targetRegionId}/orders/?datasource=tranquility&order_type=buy&type_id=${typeID}`;

        const [sellOrdersRes, buyOrdersRes] = await Promise.all([
            apiLimiter.schedule(() => axios.get(sellOrdersURL, { headers: { 'User-Agent': USER_AGENT }, validateStatus: (s) => s >= 200 && s < 500, timeout: 7000 })),
            apiLimiter.schedule(() => axios.get(buyOrdersURL, { headers: { 'User-Agent': USER_AGENT }, validateStatus: (s) => s >= 200 && s < 500, timeout: 7000 }))
        ]);

        if (sellOrdersRes.status !== 200) throw new Error(`ESI returned status ${sellOrdersRes.status} for sell orders.`);
        if (buyOrdersRes.status !== 200) throw new Error(`ESI returned status ${buyOrdersRes.status} for buy orders.`);

        const sellOrders = sellOrdersRes.data;
        const buyOrders = buyOrdersRes.data;

        let lowestSellOrder = null;
        let highestBuyOrder = null;

        if (isPlex) {
            lowestSellOrder = sellOrders.length > 0 ? sellOrders.reduce((min, o) => (o.price < min.price ? o : min)) : null;
            highestBuyOrder = buyOrders.length > 0 ? buyOrders.reduce((max, o) => (o.price > max.price ? o : max)) : null;
        } else {
            const jitaSellOrders = sellOrders.filter(o => o.system_id === JITA_SYSTEM_ID);
            lowestSellOrder = jitaSellOrders.length > 0 ? jitaSellOrders.reduce((min, o) => (o.price < min.price ? o : min)) : null;
            const jitaBuyOrders = buyOrders.filter(o => o.system_id === JITA_SYSTEM_ID);
            highestBuyOrder = jitaBuyOrders.length > 0 ? jitaBuyOrders.reduce((max, o) => (o.price > max.price ? o : max)) : null;
        }

        let message = `${itemName}${quantity > 1 ? ` x${quantity}` : ''} - `;
        const formatIsk = (amount) => parseFloat(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

        if (lowestSellOrder) message += `${isPlex ? 'Global Sell' : 'Jita Sell'}: ${formatIsk(lowestSellOrder.price * quantity)} ISK`;
        else message += `${isPlex ? 'Global Sell' : 'Jita Sell'}: (None)`;

        if (highestBuyOrder) message += `, ${isPlex ? 'Global Buy' : 'Jita Buy'}: ${formatIsk(highestBuyOrder.price * quantity)} ISK`;
        else message += `, ${isPlex ? 'Global Buy' : 'Jita Buy'}: (None)`;

        if (!lowestSellOrder && !highestBuyOrder) {
            await safeSay(channel, `❌ No market data found for "${itemName}" in ${isPlex ? 'the global market' : 'Jita'}. ❌`);
        } else {
            await safeSay(channel, message);
        }

    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 503 && retryCount < 3) {
            const retryDelay = Math.pow(2, retryCount) * 1500;
            console.warn(`[fetchMarketDataFromESI] ESI 503 for "${itemName}". Retrying in ${retryDelay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
            return fetchMarketDataFromESI(itemName, typeID, channel, quantity, retryCount + 1);
        }
        console.error(`[fetchMarketDataFromESI] Error for "${itemName}":`, error.message);
        await safeSay(channel, `❌ Error fetching market data for "${itemName}". Please try again later. ❌`);
    }
}

async function getLowestSellPrice(typeID) {
    const isPlex = (typeID === PLEX_TYPE_ID);
    const targetRegionId = isPlex ? GLOBAL_PLEX_REGION_ID : JITA_REGION_ID;
    const sellOrdersURL = `https://esi.evetech.net/latest/markets/${targetRegionId}/orders/?datasource=tranquility&order_type=sell&type_id=${typeID}`;

    try {
        const sellOrdersRes = await apiLimiter.schedule(() => axios.get(sellOrdersURL, {
            headers: { 'User-Agent': USER_AGENT },
            validateStatus: (status) => status >= 200 && status < 500,
            timeout: 5000
        }));

        if (sellOrdersRes.status !== 200) {
            console.error(`[getLowestSellPrice] Error fetching sell orders for typeID ${typeID}. Status: ${sellOrdersRes.status}`);
            return null;
        }

        const sellOrders = sellOrdersRes.data;
        if (sellOrders.length === 0) return null;

        let lowestSellOrder = null;
        if (isPlex) {
            lowestSellOrder = sellOrders.reduce((min, o) => (o.price < min.price ? o : min));
        } else {
            const jitaSellOrders = sellOrders.filter(o => o.system_id === JITA_SYSTEM_ID);
            lowestSellOrder = jitaSellOrders.length > 0 ? jitaSellOrders.reduce((min, o) => (o.price < min.price ? o : min)) : null;
        }

        return lowestSellOrder ? lowestSellOrder.price : null;

    } catch (error) {
        console.error(`[getLowestSellPrice] Error fetching lowest sell price for typeID ${typeID}: ${error.message}`);
        return null;
    }
}

async function fetchBlueprintCost(productName, channel) {
    await safeSay(channel, `Checking recipe for "${productName}"...`);
    try {
        const productTypeID = await getItemTypeID(productName);

        if (!productTypeID) {
            await safeSay(channel, `❌ Could not find an EVE item named "${productName}". Please check the spelling. ❌`);
            return;
        }
        
        if (manufacturingCache.has(productTypeID)) {
             console.log(`[fetchBlueprintCost] Manufacturing cache HIT for ${productName} (ID: ${productTypeID})`);
             const manufacturingData = manufacturingCache.get(productTypeID);
             await calculateAndSendBlueprintCost(productName, manufacturingData, channel);
             return;
        }

        const eveRefApiUrl = `https://everef.net/type/${productTypeID}.json`;
        console.log(`[fetchBlueprintCost] Fetching product data from EveRef: ${eveRefApiUrl}`);
        
        const productRes = await apiLimiter.schedule(() => axios.get(eveRefApiUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        }));
        
        const productData = productRes.data;

        if (productRes.status !== 200 || !productData.manufacturing || !productData.manufacturing.materials) {
            await safeSay(channel, `❌ No manufacturing recipe found for "${productName}". It may be a non-buildable item (e.g., a faction drop or PLEX). ❌`);
            return;
        }
        
        const manufacturingData = productData.manufacturing;
        manufacturingCache.set(productTypeID, manufacturingData);
        await calculateAndSendBlueprintCost(productName, manufacturingData, channel);

    } catch (error) {
        if (axios.isAxiosError(error)) {
            const status = error.response?.status || 'Network Error';
            console.error(`[fetchBlueprintCost] Axios Error fetching from EveRef for "${productName}": Status ${status}`);
            await safeSay(channel, `❌ Error fetching recipe data for "${productName}": API returned status ${status}. ❌`);
        } else {
            console.error(`[fetchBlueprintCost] General error for "${productName}": ${error.message}`);
            await safeSay(channel, `❌ An internal error occurred while fetching recipe for "${productName}". ❌`);
        }
    }
}

async function calculateAndSendBlueprintCost(productName, manufacturingData, channel) {
    await safeSay(channel, `Calculating material costs for "${productName}"... This may take a moment.`);

    const materials = manufacturingData.materials;
    const productInfo = manufacturingData.products[0];
    const productTypeID = productInfo.type_id;
    const productQuantity = productInfo.quantity;

    let totalMaterialCost = 0;
    let missingPrices = [];

    const pricePromises = materials.map(async (material) => {
        const price = await getLowestSellPrice(material.type_id);
        if (price !== null) {
            totalMaterialCost += price * material.quantity;
        } else {
            const materialName = getTypeNameByID(material.type_id);
            missingPrices.push(materialName);
            console.warn(`[calculateAndSendBlueprintCost] Missing price for material: ${materialName} (ID: ${material.type_id})`);
        }
    });

    const productSellPricePromise = getLowestSellPrice(productTypeID);
    const [productSellPrice] = await Promise.all([productSellPricePromise, ...pricePromises]);

    const formatIsk = (amount) => parseFloat(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let message = `Build Cost for ${productName} x${productQuantity}`;
    message += ` — Materials: ${formatIsk(totalMaterialCost)} ISK`;

    if (productSellPrice !== null) {
        const totalSellValue = productSellPrice * productQuantity;
        const profit = totalSellValue - totalMaterialCost;
        const profitSign = profit >= 0 ? '+' : '';
        
        message += ` | Jita Sell: ${formatIsk(totalSellValue)} ISK`;
        message += ` | Profit: ${profitSign}${formatIsk(profit)} ISK`;
    } else {
        message += ` | Jita Sell: (N/A)`;
    }

    if (missingPrices.length > 0) {
        const displayedMissing = missingPrices.length > 3 ? missingPrices.slice(0, 3).join(', ') + '...' : missingPrices.join(', ');
        message += ` (Prices missing for: ${displayedMissing})`;
    }

    await safeSay(channel, message);
}

// --- NEW LP STORE FUNCTIONS ---

/**
 * Fetches the Corporation ID for a given corporation name.
 * @param {string} corpName - The name of the corporation.
 * @returns {Promise<number|null>} The corporation ID or null if not found.
 */
async function getCorporationID(corpName) {
    const lowerCaseCorpName = corpName.toLowerCase();
    if (corpIDCache.has(lowerCaseCorpName)) {
        console.log(`[getCorporationID] Cache HIT for "${corpName}"`);
        return corpIDCache.get(lowerCaseCorpName);
    }

    console.log(`[getCorporationID] Cache MISS for "${corpName}". Fetching from ESI...`);
    try {
        const searchUrl = `https://esi.evetech.net/latest/search/?datasource=tranquility&categories=corporation&search=${encodeURIComponent(corpName)}&strict=false`;
        const searchRes = await apiLimiter.schedule(() => axios.get(searchUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 5000
        }));

        if (searchRes.data.corporation && searchRes.data.corporation.length > 0) {
            const corpID = searchRes.data.corporation[0];
            console.log(`[getCorporationID] ESI Success: Found Corp ID ${corpID} for "${corpName}"`);
            corpIDCache.set(lowerCaseCorpName, corpID);
            return corpID;
        } else {
            console.warn(`[getCorporationID] ESI Warning: No match found for corp "${corpName}".`);
            return null;
        }
    } catch (error) {
        console.error(`[getCorporationID] Error fetching Corp ID from ESI for "${corpName}": ${error.message}`);
        return null;
    }
}

/**
 * Fetches LP store data, calculates costs and profits, and sends the message.
 * @param {string} corpName - The corporation name for the LP store.
 * @param {string} itemName - The item to look up in the store.
 * @param {string} channel - The Twitch channel to send the message to.
 */
async function fetchLpOffer(corpName, itemName, channel) {
    await safeSay(channel, `Looking up "${itemName}" in the "${corpName}" LP store...`);

    try {
        // Step 1: Get Corporation and Item IDs
        const [corpID, itemTypeID] = await Promise.all([
            getCorporationID(corpName),
            getItemTypeID(itemName)
        ]);

        if (!corpID) {
            await safeSay(channel, `❌ Could not find a corporation named "${corpName}". Please check the spelling. ❌`);
            return;
        }
        if (!itemTypeID) {
            await safeSay(channel, `❌ Could not find an item named "${itemName}". Please check the spelling. ❌`);
            return;
        }

        // Step 2: Fetch LP Store Offers from ESI
        const offersUrl = `https://esi.evetech.net/latest/loyalty/stores/${corpID}/offers/?datasource=tranquility`;
        const offersRes = await apiLimiter.schedule(() => axios.get(offersUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 10000
        }));
        
        const offer = offersRes.data.find(o => o.type_id === itemTypeID);

        if (!offer) {
            await safeSay(channel, `❌ The item "${itemName}" was not found in the "${corpName}" LP store. ❌`);
            return;
        }

        // Step 3: Calculate costs and send the final message
        await calculateAndSendLpOfferCost(itemName, offer, channel);

    } catch (error) {
        console.error(`[fetchLpOffer] General error for "${corpName}" / "${itemName}": ${error.message}`);
        await safeSay(channel, `❌ An internal error occurred while fetching LP store data. ❌`);
    }
}

/**
 * Performs the final calculation and formatting for the !lp command.
 * @param {string} itemName - The name of the final product.
 * @param {object} offer - The LP store offer object from ESI.
 * @param {string} channel - The Twitch channel.
 */
async function calculateAndSendLpOfferCost(itemName, offer, channel) {
    await safeSay(channel, `Calculating costs for "${itemName}"... This may take a moment.`);

    let totalMaterialCost = offer.isk_cost;
    let missingPrices = [];

    // Fetch prices for all required items
    const pricePromises = offer.required_items.map(async (material) => {
        const price = await getLowestSellPrice(material.type_id);
        if (price !== null) {
            totalMaterialCost += price * material.quantity;
        } else {
            const materialName = getTypeNameByID(material.type_id);
            missingPrices.push(materialName);
            console.warn(`[calculateAndSendLpOfferCost] Missing price for material: ${materialName} (ID: ${material.type_id})`);
        }
    });

    const productSellPricePromise = getLowestSellPrice(offer.type_id);
    const [productSellPrice] = await Promise.all([productSellPricePromise, ...pricePromises]);
    
    const formatIsk = (amount) => parseFloat(amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formatLp = (amount) => amount.toLocaleString();

    if (productSellPrice === null) {
        await safeSay(channel, `❌ Could not fetch the Jita sell price for "${itemName}", cannot calculate profit. ❌`);
        return;
    }

    const profit = productSellPrice - totalMaterialCost;
    const iskPerLp = profit / offer.lp_cost;

    let message = `${itemName} — Cost: ${formatLp(offer.lp_cost)} LP + ${formatIsk(totalMaterialCost)} ISK`;
    message += ` | Jita Sell: ${formatIsk(productSellPrice)} ISK`;
    message += ` | Profit: ${formatIsk(profit)} ISK`;
    message += ` | Ratio: ${formatIsk(iskPerLp)} ISK/LP`;

    if (missingPrices.length > 0) {
        const displayedMissing = missingPrices.length > 3 ? missingPrices.slice(0, 3).join(', ') + '...' : missingPrices.join(', ');
        message += ` (Prices missing for: ${displayedMissing})`;
    }

    await safeSay(channel, message);
}


// Function to handle commands from Twitch chat
client.on('message', (channel, userstate, message, self) => {
    if (self) return;

    const args = message.trim().split(/\s+/);
    const commandName = (args.shift() || '').toLowerCase();

    if (commandName === '!market') {
        let quantity = 1;
        const lastArg = args[args.length - 1];
        const quantityMatch = lastArg ? lastArg.match(/^x(\d+)$/i) : null;

        if (quantityMatch) {
            quantity = parseInt(quantityMatch[1], 10);
            args.pop();
            if (isNaN(quantity) || quantity <= 0) {
                safeSay(channel, '❌ Invalid quantity specified. Use a positive number (e.g., x100). ❌');
                return;
            }
        }

        const itemName = args.join(' ');
        if (!itemName) {
            safeSay(channel, '❌ Please specify an item name. Usage: !market <item name> [x<quantity>] ❌');
            return;
        }

        getItemTypeID(itemName)
            .then(typeID => {
                if (typeID) {
                    fetchMarketData(itemName, typeID, channel, quantity);
                } else {
                    safeSay(channel, `❌ Could not find an EVE Online item matching "${itemName}". Check spelling? ❌`);
                }
            })
            .catch(error => {
                console.error(`[client.on('message')] Error during TypeID lookup for "${itemName}":`, error);
                safeSay(channel, `❌ Error looking up item "${itemName}". ❌`);
            });
    } else if (commandName === '!build') {
        const itemName = args.join(' ');
        if (!itemName) {
            safeSay(channel, '❌ Please specify an item name. Usage: !build <item name> ❌');
            return;
        }
        fetchBlueprintCost(itemName, channel);
    } else if (commandName === '!lp') { // <-- NEW COMMAND HANDLER
        const fullArgs = args.join(' ');
        if (!fullArgs.includes('|')) {
            safeSay(channel, '❌ Usage: !lp <corporation name> | <item name> ❌');
            return;
        }
        const parts = fullArgs.split('|').map(p => p.trim());
        const corpName = parts[0];
        const itemName = parts[1];

        if (!corpName || !itemName) {
            safeSay(channel, '❌ Usage: !lp <corporation name> | <item name> ❌');
            return;
        }
        fetchLpOffer(corpName, itemName, channel);
    }
    else if (commandName === '!info') {
        const itemName = args.join(' ');
        if (!itemName) {
            safeSay(channel, '❌ Please specify an item name. Usage: !info <item name> ❌');
            return;
        }

        getItemTypeID(itemName)
            .then(typeID => {
                if (typeID) {
                    const eveRefUrl = `https://everef.net/type/${typeID}`;
                    safeSay(channel, `${itemName} info: ${eveRefUrl}`);
                } else {
                    safeSay(channel, `❌ Could not find an EVE Online item matching "${itemName}". Check spelling? ❌`);
                }
            })
            .catch(error => {
                console.error(`[client.on('message')] Error during !info lookup for "${itemName}":`, error);
                safeSay(channel, `❌ Error looking up item "${itemName}". ❌`);
            });
    } else if (commandName === '!ping') {
        const state = client.readyState();
        const reply = `Pong! Bot is running. Twitch connection state: ${state}.`;
        console.log(`[client.on('message')] Responding to !ping in ${channel} with state ${state}`);
        safeSay(channel, reply);
    }
});

async function getItemTypeID(itemName) {
    const lowerCaseItemName = itemName.toLowerCase();

    if (isEveFilesTypeIDMapLoaded && eveFilesTypeIDMap.has(lowerCaseItemName)) {
        console.log(`[getItemTypeID] eve-files.com Cache HIT for "${itemName}"`);
        return eveFilesTypeIDMap.get(lowerCaseItemName);
    }
    if (typeIDCache.has(lowerCaseItemName)) {
        console.log(`[getItemTypeID] Fuzzwork Cache HIT for "${itemName}"`);
        return typeIDCache.get(lowerCaseItemName);
    }

    console.log(`[getItemTypeID] Cache MISS for "${itemName}". Fetching from Fuzzwork...`);
    try {
        let cleanItemName = itemName.replace(/[^a-zA-Z0-9\s'-]/g, '').trim();
        if (!cleanItemName) return null;

        const fuzzworkTypeIdUrl = `https://www.fuzzwork.co.uk/api/typeid.php?typename=${encodeURIComponent(cleanItemName)}`;
        const searchRes = await apiLimiter.schedule(() => axios.get(fuzzworkTypeIdUrl, {
            headers: { 'User-Agent': USER_AGENT },
            timeout: 5000
        }));

        const responseData = searchRes.data;
        let foundTypeID = null;

        if (Array.isArray(responseData)) {
            if (responseData.length > 0) {
                const exactMatch = responseData.find(item => item.typeName.toLowerCase() === lowerCaseItemName);
                foundTypeID = exactMatch ? exactMatch.typeID : responseData[0].typeID;
            }
        } else if (typeof responseData === 'object' && responseData !== null && responseData.typeID) {
            foundTypeID = Number(responseData.typeID);
        }

        if (foundTypeID) {
            console.log(`[getItemTypeID] Fuzzwork Success: Found TypeID ${foundTypeID} for "${itemName}"`);
            typeIDCache.set(lowerCaseItemName, foundTypeID);
            return foundTypeID;
        } else {
            console.warn(`[getItemTypeID] Fuzzwork Warning: No match found for "${itemName}". Response: ${JSON.stringify(responseData)}`);
            return null;
        }
    } catch (error) {
        console.error(`[getItemTypeID] Error fetching TypeID from Fuzzwork for "${itemName}": ${error.message}`);
        return null;
    }
}

// Express server for health checks
const port = process.env.PORT || 8080;
app.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});

app.get('/', (req, res) => {
    res.status(200).send('Eve Twitch Market Bot is running and healthy.');
});

app.get('/_health', (req, res) => {
    const clientState = client.readyState();
    if (clientState === 'OPEN') {
        res.status(200).send(`OK - Twitch client connected (State: ${clientState})`);
    } else {
        console.warn(`/_health check failed: Twitch client not connected (State: ${clientState})`);
        res.status(503).send(`Service Unavailable: Twitch client not connected (State: ${clientState})`);
    }
});

console.log("Eve Twitch Market Bot script finished loading. Waiting for connection and messages...");
