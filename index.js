const ccxt = require('ccxt');
const sumProduct = require('sum-product');
const Decimal = require('decimal');
const low = require('lowdb');
const FileSync = require('lowdb/adapters/FileSync');
const adapter = new FileSync('./data/db.json');
const db = low(adapter);

// --------------------------------------------------------

db.defaults({sellOrders: [], buyOrder: null, buyOrderPrice: null, firstSellPrice: null, firstSellTime: null, unrecoverable: false})
    .write();

const config = require('./config.json');

// --------------------------------------------------------

let balance;
let minOrderSize;
let amountPrecision;
let pricePrecision;

let sellOrders = [];
let buyOrder;
let buyOrderPrice;
let averages = [];
let firstSellPrice;

// --------------------------------------------------------

// instantiate the exchange
let coss = new ccxt.coss({
    apiKey: config.publicKey,
    secret: config.privateKey,
    enableRateLimit: true,
    rateLimit: 55
});

async function startBot() {
    await loadConfigAndTradingInfo();

    console.log('starting bot ...');

    if (sellOrders.length > 0) {
        console.log('Found existing DCA structure. Bot will check orders');
        const orderCheck = await tryCatch(canContinue());
        if (orderCheck.success) {
            console.log(orderCheck.result);
            console.log('Bot will continue from where it stopped');
        } else {
            console.log(orderCheck.error);
            console.log('Please make sure to cancel all Orders from the bot and then clear the content of /data/db.json');
            process.exit(1);
        }
    } else {
        console.log('No DCA structure found. Bot will build it now');
        await buildDCA();
    }
    checkForUpdate();
}

async function checkConfig() {
    console.log('Checking config for errors ... (TODO)');
    // TODO: really check config
    console.log('Config is fine. Good job :)');
}

async function loadConfigAndTradingInfo() {
    console.log('--------------- Loading Config and fetching Trading Info ---------------');
    await checkConfig();
    config.pair = config.pair.replace('_', '/').toUpperCase();

    console.log('Loading minOrderSize ...');
    const restriction = await tryCatch(fetchTradingRestrictionWithRetry());
    if (restriction.success) {
        minOrderSize = restriction.result;
    } else {
        console.log(restriction.error);
        process.exit(1);
    }

    console.log('Loading Precisions ...');
    const precision = await tryCatch(fetchTradingPrecisionWithRetry());
    if (precision.success) {
        amountPrecision = precision.result.amountPrecision;
        pricePrecision = precision.result.pricePrecision;
    } else {
        console.log(precision.error);
        process.exit(1);
    }

    console.log('Loading data from database ...');
    sellOrders = db.get('sellOrders').value();
    buyOrder = db.get('buyOrder').value();
    buyOrderPrice = db.get('buyOrderPrice').value();
    firstSellPrice = db.get('firstSellPrice').value();
    if (db.get('unrecoverable').value()) {
        console.log('Bot was canceled or crashed in a state it cant recover from. Please cancel all orders and delete the content of /data/db.json');
        process.exit(1);
    }

    console.log('--------------- Loaded ---------------');
}

async function canContinue() {
    return new Promise(async (resolve, reject) => {
        for (sellOrder of sellOrders) {
            console.log('checking sell order with id: ' + sellOrder);
            const order = await tryCatch(fetchOrderWithRetry(sellOrder));
            if (order.success) {
                if (order.result.status === 'canceled') {
                    reject('Sell Order with id: ' + sellOrder + ' was canceled by User');
                    return;
                }
            } else {
                reject('Unable to fetch Sell Order with id: ' + sellOrder);
                return;
            }
        }
        if (buyOrder) {
            console.log('checking buy order with id: ' + buyOrder);
            const order = await tryCatch(fetchOrderWithRetry(buyOrder));
            if (order.success) {
                if (order.result.status === 'canceled') {
                    reject('Buy Order was canceled by User');
                    return;
                } else if (order.result.status === 'closed') {
                    reject('Buy Order was filled while bot was offline');
                    return;
                }
            } else {
                reject('Unable to fetch Buy Order with id: ' + buyOrder);
                return;
            }
        }
        resolve('All orders in place');
    });
}

async function buildDCA() {
    let lowestSellPrice;
    const sellPrice = await tryCatch(getLowestSellPriceWithRetry());
    if (sellPrice.success) {
        lowestSellPrice = sellPrice.result;
    } else {
        console.log(sellPrice.error);
        process.exit(1);
    }

    const prices = [getCleanPrice(Decimal(lowestSellPrice).mul(1 + (config.startPricePercent / 100)).toNumber())];
    const amounts = [getCleanAmount(Decimal(config.startAmount).div(prices[0]).toNumber())];
    averages = [Decimal(sumProduct(prices, amounts)).div(amounts[0]).toNumber()];

    if (config.live) {
        const allBalance = await tryCatch(fetchBalanceWithRetry());
        if (allBalance.success) {
            balance = allBalance.result[config.pair.split('/')[0]];
        } else {
            console.log(allBalance.error);
            process.exit(1);
        }
    }

    config.dca.forEach(dcaAmount => {
        // Calculate price where to dca
        prices.push(getCleanPrice(Decimal(averages[averages.length - 1]).mul(1 + dcaAmount / 100).toNumber()));

        // Amount to buy at this level
        var sum = 0;
        amounts.forEach(amount => {
            sum += amount;
        });
        amounts.push(sum);

        // Calculate average price when this dca gets fulfilled
        averages.push(Decimal(sumProduct(prices, amounts)).div(sum * 2).toNumber());

        if (config.live && sum * 2 > balance.free) {
            console.log('Insufficient trading balance with set parameters. Need ' + sum * 2 + ' ' + config.pair[0] + ' available for trading');
            process.exit(1);
        }
    });
    console.log('------------------------------BUILDING DCA------------------------------');
    for (let [index, price] of prices.entries()) {
        if (config.live) {
            const sellOrder = await tryCatch(placeSellOrderWithRetry(price, amounts[index]));
            if (sellOrder.success) {
                sellOrders.push(sellOrder.result.id);
                db.set('sellOrders', sellOrders).write();
                console.log('Placed sell order with price: ' + price + ' and amount: ' + amounts[index] + ' | averagePrice: ' + averages[index]);
            } else {
                console.log(sellOrder.error);
                process.exit(1);
            }
            if (index === 0) {
                firstSellPrice = price;
                db.set('firstSellTime', Date.now()).write();
                db.set('firstSellPrice', price).write();
            }
        } else {
            console.log('DEMO MODE - Nothing gets placed');
            console.log('Placed sell order with price: ' + price + ' and amount: ' + amounts[index] + ' | averagePrice: ' + averages[index]);
        }
    }
    console.log('------------------------------------------------------------------------');
}

async function checkForUpdate() {
    console.log('Check orders for update ...');
    await timeout(3000); // Somehow I still hit the rate limit without this
    try {
        if (buyOrder) {
            await checkOrdersWithBuyOrder();
        } else {
            await checkOrders();
        }
    } catch (e) {
        console.log(e);
        checkForUpdate();
    }

}

function timeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkOrdersWithBuyOrder() {
    const order = await tryCatch(fetchOrderWithRetry(buyOrder));

    if (!order.success) {
        console.log('Failed to get buy Order');
        checkForUpdate();
        return;
    }

    if (order.result.status === 'closed') {
        console.log('buyOrder was closed');
        buyOrder = null;
        db.set('buyOrder', buyOrder).write();
        buyOrderPrice = null;
        db.set('buyOrderPrice', buyOrderPrice).write();

        await cancelAllOrders();
        await buildDCA();
    } else {
        console.log('buyOrder still alive');
        console.log('Checking if something got filled');
        const filled = [];
        const price = [];
        let sum = 0;
        for (sellOrder of sellOrders) {
            const order = await tryCatch(fetchOrderWithRetry(sellOrder));
            if (order.success) {
                filled.push(order.result.filled);
                price.push(order.result.price);
                sum += order.result.filled;
            } else {
                checkForUpdate();
                return;
            }
        }

        let average = Decimal(sumProduct(price, filled)).div(sum).toNumber();
        let buyPrice = getCleanPriceFloor(Decimal(average).mul(1 - (config.profit / 100)));
        let amount = getCleanAmountFloor(sum * average / buyPrice);

        if (buyPrice > buyOrderPrice || amount > order.result.amount) {
            amount = amount - order.result.filled;
            console.log('New buy price or amount found because sell Orders got filled');
            console.log('Cancelling old buy order ...');
            const order = await tryCatch(cancelOrderWithRetry(buyOrder));
            if (order.success) {
                console.log('Success');
                buyOrder = null;
                db.set('buyOrder', buyOrder).write();
                buyOrderPrice = null;
                db.set('buyOrderPrice', buyOrderPrice).write();

                console.log('Placing new buy order with price: ' + buyPrice + ' and amount: ' + amount);
                const newBuyOrder = await tryCatch(placeBuyOrderWithRetry(buyPrice, amount));
                if (newBuyOrder.success) {
                    console.log('Success');
                    buyOrder = newBuyOrder.result.id;
                    db.set('buyOrder', buyOrder).write();
                    buyOrderPrice = buyPrice;
                    db.set('buyOrderPrice', buyOrderPrice).write();
                } else {
                    console.log('Failed');
                    checkForUpdate();
                    return;
                }
            } else {
                console.log('Failed');
                checkForUpdate();
                return;
            }
        } else {
            console.log('All Orders can stay. No update needed');
        }
    }
    checkForUpdate();
}

async function checkOrders() {
    console.log('Checking if something got filled');
    const filled = [];
    const price = [];
    let sum = 0;
    for (sellOrder of sellOrders) {
        const order = await tryCatch(fetchOrderWithRetry(sellOrder));
        if (order.success) {
            filled.push(order.result.filled);
            price.push(order.result.price);
            sum += order.result.filled;
        } else {
            checkForUpdate();
            return;
        }
    }

    if (sum > 0) {
        console.log('Found filled sell Orders. Calculating buy price and amount ...');
        let average = Decimal(sumProduct(price, filled)).div(sum).toNumber();
        let buyPrice = getCleanPriceFloor(Decimal(average).mul(1 - (config.profit / 100)));
        let amount = getCleanAmountFloor(sum * average / buyPrice);

        if (amount > buyPrice * minOrderSize) {
            console.log('Placing buy order at price: ' + buyPrice + ' and amount: ' + amount);
            const newBuyOrder = await tryCatch(placeBuyOrderWithRetry(buyPrice, amount));
            if (newBuyOrder.success) {
                console.log('Success');
                buyOrder = newBuyOrder.result.id;
                db.set('buyOrder', buyOrder).write();
                buyOrderPrice = buyPrice;
                db.set('buyOrderPrice', buyOrderPrice).write();
            } else {
                console.log('Failed');
                checkForUpdate();
                return;
            }
        } else {
            console.log('MinOrderSize not reached. Will place buy Order when enough was sold');
        }
    } else if (config.secondsToKeepDCA >= 0 && Date.now() - db.get('firstSellTime').value() > config.secondsToKeepDCA * 1000) {
        console.log('Checking if the orderbook moved down ... ');
        const sellPrice = await tryCatch(getLowestSellPriceWithRetry());
        if (sellPrice.success) {
            if (sellPrice.result < firstSellPrice) {
                console.log('Yes. Moving all sell Orders ...');
                await cancelAllOrders();
                await buildDCA();
            }
        } else {
            console.log(sellPrice.error);
        }
    }
    checkForUpdate();
}

// --------- API CALLS -------------

async function tryCatch(promise) {
    return promise
        .then(result => ({success: true, result}))
        .catch(error => ({success: false, error}))
}

// Get the minOrderSize
async function fetchTradingRestrictionWithRetry(retries = 5) {
    return new Promise(async (resolve, reject) => {
        for (let i = 1; i <= retries; i++) {
            let limits = await tryCatch(coss.webGetCoinsGetBaseList());
            if (limits.success && limits.result.length > 0) {
                limits.result.forEach(limit => {
                    if (limit.currency === config.pair.split('/')[1]) {
                        if (config.startAmount < minOrderSize) {
                            reject(new Error('startAmount is to low on this quote. Need atleast: ' + limit.limit));
                        } else {
                            resolve(limit.limit);
                        }
                    }
                });
                return;
            }
        }
        reject(new Error('Unable to fetch minOrderSize for pair: ' + config.pair));
    });
}

// Get the precision of the amount and price
async function fetchTradingPrecisionWithRetry(retries = 5) {
    return new Promise(async (resolve, reject) => {
        for (let i = 1; i <= retries; i++) {
            let symbols = await tryCatch(coss.webGetOrderSymbols());
            if (symbols.success && symbols.result.length > 0) {
                symbols.result.forEach(symbol => {
                    if (symbol.symbol === config.pair.replace('/', '_')) {
                        resolve({
                            amountPrecision: symbol['amount_limit_decimal'],
                            pricePrecision: symbol['price_limit_decimal']
                        });
                    }
                });
                return;
            }
        }
        reject(new Error('Unable to fetch Precisions for pair: ' + config.pair));
    });
}

// Get a specific order
async function fetchOrderWithRetry(id, retries = 5) {
    return new Promise(async (resolve, reject) => {
        for (let i = 1; i <= retries; i++) {
            const order = await tryCatch(coss.fetchOrder(id, config.pair.replace('/', '_')));
            if (order.success && order.result['id']) {
                resolve(order.result);
                return;
            }
        }
        reject(new Error('Unable to fetch Order with id: ' + id));
    })
}

// Place a sell limit Order
async function placeSellOrderWithRetry(price, amount, retries = 5) {
    return new Promise(async (resolve, reject) => {
        for (let i = 1; i <= retries; i++) {
            const order = await tryCatch(coss.createLimitSellOrder(config.pair, amount, price));
            if (order.success && order.result['id']) {
                resolve(order.result);
                return;
            }
        }
        reject(new Error('Unable to place sell Order with price: ' + price + ' and amount: ' + amount));
    })
}

// Place a buy limit Order
async function placeBuyOrderWithRetry(price, amount, retries = 5) {
    return new Promise(async (resolve, reject) => {
        for (let i = 1; i <= retries; i++) {
            const order = await coss.createLimitBuyOrder(config.pair, amount, price);
            if (order.success && order.result['id']) {
                resolve(order.result);
                return;
            }
        }
        reject(new Error('Unable to place buy Order with price: ' + price + ' and amount: ' + amount));
    })
}

// Cancel an existing order
async function cancelOrderWithRetry(id, retries = 5) {
    return new Promise(async (resolve, reject) => {
        const order = await tryCatch(fetchOrderWithRetry(id));
        if (order.success) {
            if (order.result.status === 'open') {
                for (let i = 1; i <= retries; i++) {
                    const order = await tryCatch(coss.cancelOrder(id, config.pair.replace('_', '/')));
                    if (order.success && order.result['id']) {
                        resolve('Order canceled');
                        return;
                    }
                }
            } else {
                resolve('Order already canceled or closed');
                return;
            }

        }
        reject(new Error('Unable to cancel order with id: ' + id));
    })
}

// Cancel all orders
async function cancelAllOrders(retries = 3) {
    console.log('Cancelling all sell Orders');
    return new Promise(async (resolve, reject) => {
        let sellOrdersCopy = sellOrders;
        for (let i = 1; i <= retries; i++) {
            const unCanceledOrders = [];
            for (sellOrder of sellOrdersCopy) {
                console.log('Canceling sell Order with id: ' + sellOrder);
                const canceledOrder = await tryCatch(cancelOrderWithRetry(sellOrder));
                if (canceledOrder.success) {
                    console.log(canceledOrder.result);
                } else {
                    console.log(canceledOrder.error);
                    unCanceledOrders.push(sellOrder);
                }
            }
            sellOrdersCopy = unCanceledOrders;
            db.set('sellOrders', sellOrdersCopy).write();
            db.set('firstSellPrice', null).write();

            if (sellOrdersCopy.length === 0) {
                sellOrders = sellOrdersCopy;
                resolve(sellOrders);
                return;
            }
        }
        db.set('unrecoverable', true).write();
        reject(new Error('Bot wasnt able to cancel all orders. Please cancel them and restart the bot.'));
        process.exit(1);
    })
}

// Get balance
async function fetchBalanceWithRetry(retries = 5) {
    return new Promise(async (resolve, reject) => {
        for (let i = 1; i <= retries; i++) {
            const balance = await tryCatch(coss.fetchBalance());
            if (balance.success) {
                resolve(balance.result);
                return;
            }
        }
        reject(new Error('Unable to get the balance'));
    })
}

// Get the lowest sell price in the orderBook
async function getLowestSellPriceWithRetry(retries = 5) {
    return new Promise(async (resolve, reject) => {
        for (let i = 1; i <= retries; i++) {
            let ticker = await tryCatch(coss.fetchTicker(config.pair.replace('_', '/')));
            if (ticker.success && ticker.result['ask']) {
                resolve(ticker.result.ask);
                return;
            }
        }
        reject(new Error('Unable to get the ticker for pair: ' + config.pair));
    });
}

// --------- API CALLS END -------------

function getCleanPrice(price) {
    return Math.ceil(Math.pow(10, pricePrecision) * price) / Math.pow(10, pricePrecision);
}

function getCleanPriceFloor(price) {
    return Math.ceil(Math.pow(10, pricePrecision) * price) / Math.pow(10, pricePrecision);
}

function getCleanAmount(amount) {
    return Math.ceil(Math.pow(10, amountPrecision) * amount) / Math.pow(10, amountPrecision);
}

function getCleanAmountFloor(amount) {
    return Math.ceil(Math.pow(10, amountPrecision) * amount) / Math.pow(10, amountPrecision);
}



try {
    startBot();
} catch (e) {
    console.log('Unhandled Error', e);
}




