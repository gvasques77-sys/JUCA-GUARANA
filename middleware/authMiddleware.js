/**
 * Auth Middleware — Supabase JWT Validation (Fase 5)
 *
 * Valida o JWT emitido pelo Supabase Auth, injeta req.clinicId,
 * req.userId e req.userRole em todas as rotas protegidas.
 *
 * REGRAS:
 * - Retorna 401 se token ausente, inválido ou expirado
 * - Busca clinic_id e role na tabela clinic_users
 * - Prefixo [AUTH] em todos os logs
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

// Cliente leve para validar JWT (usa anon key internamente via getUser)
const supabaseAuth = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Cache simples para evitar queries repetidas à clinic_users (TTL 5 min)
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCachedUser(userId) {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    userCache.delete(userId);
    return null;
  }
  return entry.data;
}

function setCachedUser(userId, data) {
  userCache.set(userId, { data, ts: Date.now() });
}

/**
 * Middleware de autenticação para rotas CRM.
 * Espera header: Authorization: Bearer <jwt_supabase>
 *
 * Injeta:
 *   req.userId   — UUID do auth.users
 *   req.clinicId — UUID da clínica vinculada
 *   req.userRole — 'owner' | 'staff'
 *   req.userName — nome do usuário
 */
export function authMiddleware(supabase) {
  return async function (req, res, next) {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Token de autenticação ausente' });
      }

      const token = authHeader.slice(7);
      if (!token) {
        return res.status(401).json({ error: 'Token de autenticação vazio' });
      }

      // Validar JWT com Supabase Auth
      const { data: { user }, error: authError } = await supabaseAuth.auth.getUser(token);

      if (authError || !user) {
        console.warn('[AUTH] Token inválido ou expirado:', authError?.message || 'user null');
        return res.status(401).json({ error: 'Token inválido ou expirado' });
      }

      // Buscar dados do clinic_users (com cache)
      let clinicUser = getCachedUser(user.id);

      if (!clinicUser) {
        const { data, error: cuError } = await supabase
          .from('clinic_users')
          .select('clinic_id, role, name')
          .eq('id', user.id)
          .single();

        if (cuError || !data) {
          console.warn('[AUTH] Usuário não vinculado a nenhuma clínica:', user.id);
          return res.status(403).json({ error: 'Usuário não vinculado a nenhuma clínica. Contate o administrador.' });
        }

        clinicUser = data;
        setCachedUser(user.id, clinicUser);
      }

      // Injetar dados no request
      req.userId = user.id;
      req.clinicId = clinicUser.clinic_id;
      req.userRole = clinicUser.role;
      req.userName = clinicUser.name || user.email;

      next();
    } catch (err) {
      console.error('[AUTH] Erro inesperado no middleware:', err.message);
      return res.status(500).json({ error: 'Erro interno de autenticação' });
    }
  };
}

/**
 * Middleware que restringe acesso a owners.
 * Deve ser usado APÓS authMiddleware.
 */
export function requireOwner(req, res, next) {
  if (req.userRole !== 'owner') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador da clínica' });
  }
  next();
}
