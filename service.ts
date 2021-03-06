import { ETHTokenType, ImmutableMethodParams, ImmutableOrderStatus, ImmutableTransactionStatus, ImmutableXClient } from '@imtbl/imx-sdk';
import fs from 'fs';
import Web3 from 'web3-utils';
import _ from 'underscore';
import moment from 'moment';
import * as db from './db';

import { AsyncIndependentJob, AsyncJobSequence, RetryOptions, AsyncJob } from './etl';
import { logger } from './logger';


const apiAddress = 'https://api.x.immutable.com/v1';
 
const GUCollectionAddress = '0xacb3c6a43d15b907e8433077b6d38ae40936fe2c';

const ERC20TokenAddress = {
  GODS: '0xccc8cb5229b0ac8069c51fd58367fd1e622afd97',
  IMX: '0xf57e7e7c23978c3caec3c3548e3d615c346e79ff'
}


function weiToEth(value: bigint): string {
  return Web3.fromWei(value.toString());
}


function weiToGwei(value: bigint): bigint {
  return value / BigInt(10) ** BigInt(9);
}


async function createImmutableXClient(): Promise<ImmutableXClient> {
  return await ImmutableXClient.build({ publicApiUrl: apiAddress });
}


async function fetchAssets(client: ImmutableXClient, options: object): Promise<any[]> {
  let assetCursor
  let assets: any[] = []
  do {
    let assetRequest = await client.getAssets({ ...options, cursor: assetCursor })
    assets = assets.concat(assetRequest.result)
    assetCursor = assetRequest.cursor
  } while (assetCursor)

  return assets;
}


function saveAssets(assets: any[], path: string) {
  try {
    fs.writeFileSync(path, JSON.stringify(assets, null, ' '));
  } catch (err) {
    logger.error(err);
  }
}


function loadAssetsFromFile(path: string) {
  return JSON.parse(fs.readFileSync(path).toString());
}


async function fetchAndSaveAssets(client: ImmutableXClient, user: string) {
  const assets = await fetchAssets(
    client, {
      collection: GUCollectionAddress,
      user: user
    }
  );
  saveAssets(assets, 'assets.json');
}


function groupAssetsByProtoQuality(assets) {
  const assetsUniq = {};
  for (let asset of assets) {
    const key = `${asset.metadata.proto}_${asset.metadata.quality}`;
    if (!assetsUniq[key]) {
      assetsUniq[key] = [];
    }
    assetsUniq[key].push(asset);
  }
  return assetsUniq;
}


async function calcAssetsTotalValue(assets: Array<any>) {
  logger.info(`total assets: ${assets.length}`)
  
  const assetsUniq = groupAssetsByProtoQuality(assets);

  logger.info(`total uniq assets: ${Object.keys(assetsUniq).length}`)

  const client = await ImmutableXClient.build({ publicApiUrl: apiAddress });

  let value = BigInt(0);

  for (let key in assetsUniq) {
    let asset = assetsUniq[key][0];
    let assetsNumber = assetsUniq[key].length;

    logger.info(`Calculating asset price for ${asset.metadata.name}, quality=${asset.metadata.quality}, number=${assetsNumber}`);
    let assetPrice = await calcAssetPrice(client, asset);
    
    logger.info(`Asset price: ${weiToEth(assetPrice)} Eth`);

    value += BigInt(assetsNumber) * assetPrice;
  }
  return value;
}


async function getBestSellOrder(client: ImmutableXClient, asset) {
  const metadata = JSON.stringify({
    proto: [`${asset.metadata.proto}`],  // sic! Array must consist of strings
    quality: [asset.metadata.quality]
  });

  let params = {
    status: ImmutableOrderStatus.active,
    sell_token_address: GUCollectionAddress,
    sell_metadata: metadata,
    buy_token_address: '',
    buy_token_type: ETHTokenType.ETH,
    order_by: 'buy_quantity',
    direction: ImmutableMethodParams.ImmutableSortOrder.asc,
    page_size: 1
  };
  
  const ordersRequest = await client.getOrders(params)
  return ordersRequest.result[0];
}



async function calcAssetPrice(client: ImmutableXClient, asset): Promise<bigint> {
  // There is no buy-limit orders on Tokentrove
  // Use best sell price as "market" price
  const order = await getBestSellOrder(client, asset);

  if (!order) {
    logger.warn('no sell orders');
    return BigInt(0);
  }

  // Also api returns quantity_with_fees property in Decimal format
  // But this property is missing in type definitions
  return order.buy.data.quantity.toBigInt();
}


async function getAssetsByName(client: ImmutableXClient, name:string) {
  // Search by asset name works not by exact match, but as full-text search
  // Try 'Tavern Brawler' for example.
  // Use filtering by proto to get exact match

  const assetRequest = await client.getAssets({
    collection: GUCollectionAddress,
    name: name
  });

  return assetRequest.result;
}


async function fetchProtoPrice(
  client: ImmutableXClient, 
  proto: number
): Promise<{
  proto: number, 
  price?: BigInt
}> {
  logger.info(`fetch price for proto ${proto}`);

  const price = await calcAssetPrice(client, {
    metadata: {
      proto: proto,
      quality: 'Meteorite'
    }
  });

  const dateStr = moment().format('YYYY-MM-DD');
  const priceGwei = weiToGwei(price);

  const query = 'INSERT INTO proto_price(date, proto, price) VALUES ' + 
    `('${dateStr}', ${proto}, ${priceGwei})` +
    `ON CONFLICT (date, proto) DO UPDATE SET price = ${priceGwei}`;
  logger.debug(query);

  await db.query(query, []);

  return {
    proto: proto,
    price: price
  };
}


function defaultRetryOptions(): RetryOptions {
  return {
    maxRetries: 5
  };
}


function createFetchProtoPriceJob (
  client: ImmutableXClient, 
  proto: number
): AsyncJob {
  return new AsyncIndependentJob(
    _.partial(fetchProtoPrice, client, proto), 
    defaultRetryOptions()
  );
}


function createFetchProtoRangePriceJob(
  client: ImmutableXClient, 
  range: {from: number, to: number}
): AsyncJobSequence {
  const deps: AsyncJob[] = []; 

  for (let proto=range.from; proto < range.to; proto++) {
    deps.push(createFetchProtoPriceJob(client, proto));
  }

  return new AsyncJobSequence(deps, defaultRetryOptions());
}


export {
  createImmutableXClient,
  createFetchProtoRangePriceJob
};
