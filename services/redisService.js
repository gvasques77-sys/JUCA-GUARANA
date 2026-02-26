// services/redisService.js
import { createClient } from 'redis';

const REDIS_TTL_CONVERSATION  = 60 * 30;
const REDIS_TTL_RATE_LIMIT    = 60;
const REDIS_TTL_SLOTS_CACHE   = 60 * 5;
const RATE_LIMIT_MAX_REQUESTS = 20;

let redisClient = null;
let redisConnected = false;

export async function getRedisClient() {
    if (redisClient && redisConnected) return redisClient;

    const redisUrl = process.env.REDIS_URL || 'redis://redis.railway.internal:6379';

    redisClient = createClient({
        url: redisUrl,
        socket: {
            reconnectStrategy: (retries) => {
                if (retries > 5) {
                    console.warn('[Redis] Falha ao reconectar após 5 tentativas — operando sem cache');
                    return false;
                }
                return Math.min(retries * 200, 2000);
            },
            connectTimeout: 3000,
        }
    });

    redisClient.on('connect', () => {
        redisConnected = true;
        console.log('[Redis] Conectado com sucesso');
    });

    redisClient.on('error', (err) => {
        redisConnected = false;
        console.warn('[Redis] Erro de conexão (sistema continua sem cache):', err.message);
    });

    try {
        await redisClient.connect();
    } catch (err) {
        console.warn('[Redis] Não foi possível conectar — modo degradado:', err.message);
        redisConnected = false;
    }

    return redisClient;
}

async function safeRedisOp(operation) {
    try {
        const client = await getRedisClient();
        if (!redisConnected) return null;
        return await operation(client);
    } catch (err) {
        console.warn('[Redis] Operação falhou silenciosamente:', err.message);
        return null;
    }
}

function conversationKey(clinicId, fromNumber) {
    return `conv:${clinicId}:${fromNumber}`;
}

export async function getConversationState(clinicId, fromNumber) {
    const raw = await safeRedisOp(client => client.get(conversationKey(clinicId, fromNumber)));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export async function setConversationState(clinicId, fromNumber, stateJson) {
    return safeRedisOp(client =>
        client.setEx(conversationKey(clinicId, fromNumber), REDIS_TTL_CONVERSATION, JSON.stringify(stateJson))
    );
}

export async function deleteConversationState(clinicId, fromNumber) {
    return safeRedisOp(client => client.del(conversationKey(clinicId, fromNumber)));
}

export async function checkRateLimit(fromNumber) {
    const key = `rl:${fromNumber}`;
    const result = await safeRedisOp(async (client) => {
        const current = await client.incr(key);
        if (current === 1) await client.expire(key, REDIS_TTL_RATE_LIMIT);
        const ttl = await client.ttl(key);
        return { current, ttl };
    });
    if (!result) return { allowed: true, remaining: RATE_LIMIT_MAX_REQUESTS, resetIn: 60 };
    const { current, ttl } = result;
    const allowed = current <= RATE_LIMIT_MAX_REQUESTS;
    const remaining = Math.max(0, RATE_LIMIT_MAX_REQUESTS - current);
    if (!allowed) console.warn(`[Redis] Rate limit atingido para ${fromNumber}: ${current} msgs/min`);
    return { allowed, remaining, resetIn: ttl };
}

function slotsKey(clinicId, doctorId, date) {
    return `slots:${clinicId}:${doctorId}:${date}`;
}

export async function getCachedSlots(clinicId, doctorId, date) {
    const raw = await safeRedisOp(client => client.get(slotsKey(clinicId, doctorId, date)));
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

export async function setCachedSlots(clinicId, doctorId, date, slotsData) {
    return safeRedisOp(client =>
        client.setEx(slotsKey(clinicId, doctorId, date), REDIS_TTL_SLOTS_CACHE, JSON.stringify(slotsData))
    );
}

export async function invalidateSlotsCache(clinicId, doctorId, date) {
    return safeRedisOp(client => client.del(slotsKey(clinicId, doctorId, date)));
}

export async function redisHealthCheck() {
    try {
        const client = await getRedisClient();
        if (!redisConnected) return { ok: false, reason: 'not_connected' };
        await client.ping();
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err.message };
    }
}
