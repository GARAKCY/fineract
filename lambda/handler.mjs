import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import bcrypt from 'bcryptjs';

const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'us-east-1' }));
const secrets = new SecretsManagerClient({ region: 'us-east-1' });

const TABLE  = process.env.DYNAMODB_TABLE;
const BRIDGE = process.env.BRIDGE_BASE || 'https://api.bridge.xyz/v0';

let _cachedKey = null;

async function getBridgeKey() {
  if (_cachedKey) return _cachedKey;
  // Prefer direct env var (simpler); fall back to Secrets Manager
  if (process.env.BRIDGE_API_KEY) {
    _cachedKey = process.env.BRIDGE_API_KEY;
    return _cachedKey;
  }
  const res = await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SECRETS_ARN }));
  _cachedKey = JSON.parse(res.SecretString).BRIDGE_API_KEY;
  return _cachedKey;
}

async function bridgeFetch(path, method = 'GET', body = null, qs = '', idempotencyKey = null) {
  const key = await getBridgeKey();
  const url = `${BRIDGE}${path}${qs ? '?' + qs : ''}`;
  const headers = { 'Api-Key': key, 'Content-Type': 'application/json' };
  if (method === 'POST') headers['Idempotency-Key'] = idempotencyKey || crypto.randomUUID();
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const data = await r.json().catch(() => ({}));
  return { status: r.status, data };
}

function ok(body, status = 200) {
  return {
    statusCode: status,
    headers: cors(),
    body: JSON.stringify(body)
  };
}

function err(message, status = 400) {
  return {
    statusCode: status,
    headers: cors(),
    body: JSON.stringify({ error: message })
  };
}

function cors() {
  return { 'Content-Type': 'application/json' };
}

export async function handler(event) {
  try {
    const path = event.rawPath || '/';
    const method = event.requestContext?.http?.method || 'GET';

    if (method === 'OPTIONS') return ok({});

    let body = null;
    if (event.body) {
      try { body = JSON.parse(event.body); } catch {}
    }

    const qs = event.queryStringParameters
      ? new URLSearchParams(event.queryStringParameters).toString()
      : '';

    const idempotencyKey = event.headers?.['idempotency-key'] || null;
    if (path === '/auth/signup'    && method === 'POST') return signup(body);
    if (path === '/auth/login'     && method === 'POST') return login(body);
    if (path === '/auth/kyc-links' && method === 'POST') return getKycLinks(body);
    if (path.startsWith('/bridge/')) return proxy(path.slice(8), method, body, qs, idempotencyKey);

    return err('Not found', 404);
  } catch (e) {
    console.error('Unhandled error:', e);
    return err(`Server error: ${e.message}`, 500);
  }
}

async function signup(body) {
  const { first_name, last_name, email, password } = body || {};
  if (!first_name || !last_name || !email || !password)
    return err('first_name, last_name, email, and password are required');
  if (password.length < 8)
    return err('Password must be at least 8 characters');

  const existing = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { email } }));
  if (existing.Item) return err('An account with this email already exists', 409);

  const { status: cs, data: customer } = await bridgeFetch('/customers', 'POST', {
    first_name, last_name, email, type: 'individual'
  });
  if (cs !== 201 && cs !== 200)
    return err(customer?.message || 'Failed to create customer', 502);

  const password_hash = await bcrypt.hash(password, 10);
  await dynamo.send(new PutCommand({
    TableName: TABLE,
    Item: {
      email,
      bridge_customer_id: customer.id,
      first_name,
      last_name,
      password_hash,
      created_at: new Date().toISOString()
    }
  }));

  const { kyc_link_url, tos_link_url } = await fetchKycLinks(first_name, last_name, email);

  return ok({
    customer_id: customer.id,
    first_name,
    last_name,
    email,
    kyc_status: customer.status,
    kyc_link_url,
    tos_link_url
  }, 201);
}

async function login(body) {
  const { email, password } = body || {};
  if (!email || !password) return err('email and password are required');

  let result;
  try {
    result = await dynamo.send(new GetCommand({ TableName: TABLE, Key: { email } }));
  } catch (e) {
    return err(`DynamoDB error: ${e.message}`, 500);
  }

  if (!result.Item) return err('Invalid email or password', 401);

  const valid = await bcrypt.compare(password, result.Item.password_hash);
  if (!valid) return err('Invalid email or password', 401);

  const { data: customer } = await bridgeFetch(`/customers/${result.Item.bridge_customer_id}`, 'GET');

  return ok({
    customer_id: result.Item.bridge_customer_id,
    first_name: result.Item.first_name,
    last_name: result.Item.last_name,
    email: result.Item.email,
    kyc_status: customer.status,
    has_accepted_tos: customer.has_accepted_terms_of_service
  });
}

async function fetchKycLinks(first_name, last_name, email) {
  const { status, data } = await bridgeFetch('/kyc_links', 'POST', {
    full_name: `${first_name} ${last_name}`,
    email,
    type: 'individual'
  });
  // Bridge returns 400 duplicate_record when a link already exists for this email;
  // the existing link is included in data.existing_kyc_link
  const resolved = (status === 400 && data?.existing_kyc_link) ? data.existing_kyc_link : data;
  return {
    kyc_link_url: resolved?.kyc_link || null,
    tos_link_url: resolved?.tos_link || null
  };
}

async function getKycLinks(body) {
  const { first_name, last_name, email } = body || {};
  if (!first_name || !last_name || !email) return err('first_name, last_name, email are required');
  const links = await fetchKycLinks(first_name, last_name, email);
  return ok(links);
}

async function proxy(bridgePath, method, body, qs, idempotencyKey) {
  const { status, data } = await bridgeFetch(`/${bridgePath}`, method, body, qs, idempotencyKey);
  return { statusCode: status, headers: cors(), body: JSON.stringify(data) };
}

export async function healthcheck() {
  return ok({ status: 'ok', table: TABLE, bridge: BRIDGE });
}
