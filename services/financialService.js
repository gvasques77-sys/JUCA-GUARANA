// ============================================================
// services/financialService.js — F10: Inteligencia Financeira
// JUCA GUARANA — GV AUTOMACOES
// ============================================================
// Multi-tenant: todas as funcoes recebem clinicId.
// Usa service_role_key (bypass RLS).
// ============================================================

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const sb = createClient(supabaseUrl, supabaseKey);

// ============================================================
// HELPERS
// ============================================================

function getMonthRange(period, referenceDate) {
  var now = referenceDate ? new Date(referenceDate) : new Date();
  var startDate, endDate;

  if (period === 'week') {
    var day = now.getDay();
    startDate = new Date(now);
    startDate.setDate(now.getDate() - day);
    startDate.setHours(0, 0, 0, 0);
    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
  } else if (period === 'year') {
    startDate = new Date(now.getFullYear(), 0, 1);
    endDate = new Date(now.getFullYear(), 11, 31);
  } else {
    // month (default)
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  }

  return {
    startDate: startDate.toISOString().split('T')[0],
    endDate: endDate.toISOString().split('T')[0]
  };
}

function getPreviousPeriodRange(period) {
  var now = new Date();
  var prev;

  if (period === 'week') {
    prev = new Date(now);
    prev.setDate(now.getDate() - 7);
  } else if (period === 'year') {
    prev = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  } else {
    prev = new Date(now.getFullYear(), now.getMonth() - 1, 15);
  }

  return getMonthRange(period, prev.toISOString());
}

function calcDelta(current, previous) {
  if (!previous || previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 100 * 10) / 10;
}

function monthKeyFromDate(dateStr) {
  return dateStr.substring(0, 7); // 'YYYY-MM'
}

// ============================================================
// 1. getFinancialOverview
// ============================================================
export async function getFinancialOverview(clinicId, period) {
  try {
    var range = getMonthRange(period || 'month');
    var prevRange = getPreviousPeriodRange(period || 'month');

    // Current period revenue
    var { data: appts, error: apptErr } = await sb
      .from('appointments')
      .select('price, status, created_by')
      .eq('clinic_id', clinicId)
      .gte('appointment_date', range.startDate)
      .lte('appointment_date', range.endDate);

    if (apptErr) return { success: false, error: apptErr.message };

    var totalRevenue = 0, revenueBot = 0, revenueManual = 0;
    var totalAppointments = 0, appointmentsBot = 0;
    var lostCancellation = 0, totalCancellations = 0;
    var lostNoshow = 0, totalNoshows = 0;
    var pricesForAvg = [];

    (appts || []).forEach(function(a) {
      var price = parseFloat(a.price) || 0;
      if (a.status === 'cancelled') {
        lostCancellation += price;
        totalCancellations++;
        return;
      }
      if (a.status === 'no_show') {
        lostNoshow += price;
        totalNoshows++;
        return;
      }
      totalRevenue += price;
      totalAppointments++;
      if (price > 0) pricesForAvg.push(price);
      if (a.created_by === 'whatsapp') {
        revenueBot += price;
        appointmentsBot++;
      } else {
        revenueManual += price;
      }
    });

    var avgTicket = pricesForAvg.length > 0
      ? Math.round((pricesForAvg.reduce(function(s, v) { return s + v; }, 0) / pricesForAvg.length) * 100) / 100
      : 0;

    // Previous period for deltas
    var { data: prevAppts } = await sb
      .from('appointments')
      .select('price, status, created_by')
      .eq('clinic_id', clinicId)
      .gte('appointment_date', prevRange.startDate)
      .lte('appointment_date', prevRange.endDate);

    var prevRevenue = 0, prevCancellations = 0;
    (prevAppts || []).forEach(function(a) {
      if (a.status !== 'cancelled' && a.status !== 'no_show') {
        prevRevenue += (parseFloat(a.price) || 0);
      }
      if (a.status === 'cancelled') prevCancellations++;
    });

    // AI cost from conversations
    var monthKey = range.startDate.substring(0, 7);
    var { data: convos } = await sb
      .from('conversations')
      .select('total_cost_estimated')
      .eq('clinic_id', clinicId)
      .gte('created_at', range.startDate + 'T00:00:00Z')
      .lte('created_at', range.endDate + 'T23:59:59Z');

    var aiCost = 0;
    (convos || []).forEach(function(c) {
      aiCost += parseFloat(c.total_cost_estimated) || 0;
    });

    return {
      success: true,
      data: {
        period: period || 'month',
        range: range,
        totalRevenue: Math.round(totalRevenue * 100) / 100,
        revenueBot: Math.round(revenueBot * 100) / 100,
        revenueManual: Math.round(revenueManual * 100) / 100,
        revenueBotPercent: totalRevenue > 0 ? Math.round((revenueBot / totalRevenue) * 100) : 0,
        totalAppointments: totalAppointments,
        appointmentsBot: appointmentsBot,
        avgTicket: avgTicket,
        lostCancellation: Math.round(lostCancellation * 100) / 100,
        totalCancellations: totalCancellations,
        lostNoshow: Math.round(lostNoshow * 100) / 100,
        totalNoshows: totalNoshows,
        aiCost: Math.round(aiCost * 100) / 100,
        deltas: {
          revenue: calcDelta(totalRevenue, prevRevenue),
          cancellations: calcDelta(totalCancellations, prevCancellations)
        }
      }
    };
  } catch (err) {
    console.error('[FinancialService] getFinancialOverview erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 2. getRevenueByDoctor
// ============================================================
export async function getRevenueByDoctor(clinicId, period) {
  try {
    var range = getMonthRange(period || 'month');

    var { data: appts, error } = await sb
      .from('appointments')
      .select('price, status, doctor_id')
      .eq('clinic_id', clinicId)
      .gte('appointment_date', range.startDate)
      .lte('appointment_date', range.endDate)
      .not('status', 'eq', 'cancelled');

    if (error) return { success: false, error: error.message };

    // Group by doctor
    var byDoctor = {};
    (appts || []).forEach(function(a) {
      if (!a.doctor_id) return;
      if (!byDoctor[a.doctor_id]) {
        byDoctor[a.doctor_id] = { doctor_id: a.doctor_id, revenue: 0, count: 0, prices: [] };
      }
      var price = parseFloat(a.price) || 0;
      byDoctor[a.doctor_id].revenue += price;
      byDoctor[a.doctor_id].count++;
      if (price > 0) byDoctor[a.doctor_id].prices.push(price);
    });

    // Fetch doctor names
    var doctorIds = Object.keys(byDoctor);
    var doctorNames = {};
    if (doctorIds.length > 0) {
      var { data: doctors } = await sb
        .from('doctors')
        .select('id, name')
        .in('id', doctorIds);

      (doctors || []).forEach(function(d) {
        doctorNames[d.id] = d.name;
      });
    }

    var result = Object.values(byDoctor).map(function(d) {
      var avgTicket = d.prices.length > 0
        ? Math.round((d.prices.reduce(function(s, v) { return s + v; }, 0) / d.prices.length) * 100) / 100
        : 0;
      return {
        doctor_id: d.doctor_id,
        doctor_name: doctorNames[d.doctor_id] || 'Sem nome',
        revenue: Math.round(d.revenue * 100) / 100,
        appointments: d.count,
        avg_ticket: avgTicket
      };
    });

    result.sort(function(a, b) { return b.revenue - a.revenue; });

    return { success: true, data: result };
  } catch (err) {
    console.error('[FinancialService] getRevenueByDoctor erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 3. getRevenueTimeline
// ============================================================
export async function getRevenueTimeline(clinicId, months) {
  try {
    var numMonths = parseInt(months) || 6;
    var now = new Date();
    var timeline = [];

    for (var i = numMonths - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      var startDate = d.toISOString().split('T')[0];
      var endD = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      var endDate = endD.toISOString().split('T')[0];
      var monthKey = startDate.substring(0, 7);

      var { data: appts } = await sb
        .from('appointments')
        .select('price, status, created_by')
        .eq('clinic_id', clinicId)
        .gte('appointment_date', startDate)
        .lte('appointment_date', endDate)
        .not('status', 'eq', 'cancelled');

      var revenue = 0, revenueBot = 0, revenueManual = 0, count = 0;
      (appts || []).forEach(function(a) {
        if (a.status === 'no_show') return;
        var price = parseFloat(a.price) || 0;
        revenue += price;
        count++;
        if (a.created_by === 'whatsapp') revenueBot += price;
        else revenueManual += price;
      });

      timeline.push({
        month: monthKey,
        revenue: Math.round(revenue * 100) / 100,
        revenueBot: Math.round(revenueBot * 100) / 100,
        revenueManual: Math.round(revenueManual * 100) / 100,
        appointments: count
      });
    }

    return { success: true, data: timeline };
  } catch (err) {
    console.error('[FinancialService] getRevenueTimeline erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 4. getExpenses
// ============================================================
export async function getExpenses(clinicId, month) {
  try {
    var { data, error } = await sb
      .from('clinic_expenses')
      .select('*')
      .eq('clinic_id', clinicId)
      .eq('reference_month', month)
      .order('category', { ascending: true });

    if (error) return { success: false, error: error.message };

    var total = (data || []).reduce(function(s, e) { return s + (parseFloat(e.amount) || 0); }, 0);

    return { success: true, data: { expenses: data || [], total: Math.round(total * 100) / 100 } };
  } catch (err) {
    console.error('[FinancialService] getExpenses erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 5. createExpense
// ============================================================
export async function createExpense(clinicId, userId, expenseData) {
  try {
    var { data, error } = await sb
      .from('clinic_expenses')
      .insert({
        clinic_id: clinicId,
        category: expenseData.category,
        description: expenseData.description || null,
        amount: expenseData.amount,
        recurrence: expenseData.recurrence || 'monthly',
        reference_month: expenseData.reference_month,
        created_by: userId
      })
      .select()
      .single();

    if (error) return { success: false, error: error.message };
    return { success: true, data: data };
  } catch (err) {
    console.error('[FinancialService] createExpense erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 6. updateExpense
// ============================================================
export async function updateExpense(clinicId, expenseId, expenseData) {
  try {
    var updates = {};
    if (expenseData.category !== undefined) updates.category = expenseData.category;
    if (expenseData.description !== undefined) updates.description = expenseData.description;
    if (expenseData.amount !== undefined) updates.amount = expenseData.amount;
    if (expenseData.recurrence !== undefined) updates.recurrence = expenseData.recurrence;
    if (expenseData.reference_month !== undefined) updates.reference_month = expenseData.reference_month;
    if (expenseData.is_active !== undefined) updates.is_active = expenseData.is_active;

    var { data, error } = await sb
      .from('clinic_expenses')
      .update(updates)
      .eq('id', expenseId)
      .eq('clinic_id', clinicId)
      .select()
      .single();

    if (error) return { success: false, error: error.message };
    return { success: true, data: data };
  } catch (err) {
    console.error('[FinancialService] updateExpense erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 7. deleteExpense
// ============================================================
export async function deleteExpense(clinicId, expenseId) {
  try {
    var { error } = await sb
      .from('clinic_expenses')
      .delete()
      .eq('id', expenseId)
      .eq('clinic_id', clinicId);

    if (error) return { success: false, error: error.message };
    return { success: true };
  } catch (err) {
    console.error('[FinancialService] deleteExpense erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 8. getDRE
// ============================================================
export async function getDRE(clinicId, month) {
  try {
    // Parse month to date range
    var startDate = month + '-01';
    var parts = month.split('-');
    var endD = new Date(parseInt(parts[0]), parseInt(parts[1]), 0);
    var endDate = endD.toISOString().split('T')[0];

    // Fetch appointments
    var { data: appts } = await sb
      .from('appointments')
      .select('price, status')
      .eq('clinic_id', clinicId)
      .gte('appointment_date', startDate)
      .lte('appointment_date', endDate);

    var receitaBruta = 0, cancelamentos = 0;
    (appts || []).forEach(function(a) {
      var price = parseFloat(a.price) || 0;
      if (a.status === 'cancelled') {
        cancelamentos += price;
      } else {
        receitaBruta += price;
      }
    });

    var receitaLiquida = receitaBruta;

    // Fetch config
    var config = await getFinancialConfig(clinicId);
    var taxRate = config.data ? parseFloat(config.data.tax_rate) || 6 : 6;
    var cardFeeRate = config.data ? parseFloat(config.data.card_fee_rate) || 3.5 : 3.5;

    var impostos = receitaLiquida * (taxRate / 100);
    var taxaCartao = receitaLiquida * (cardFeeRate / 100);

    // Fetch expenses
    var expenses = await getExpenses(clinicId, month);
    var custosOperacionais = expenses.success ? expenses.data.total : 0;

    // AI cost
    var { data: convos } = await sb
      .from('conversations')
      .select('total_cost_estimated')
      .eq('clinic_id', clinicId)
      .gte('created_at', startDate + 'T00:00:00Z')
      .lte('created_at', endDate + 'T23:59:59Z');

    var custoIA = 0;
    (convos || []).forEach(function(c) {
      custoIA += parseFloat(c.total_cost_estimated) || 0;
    });

    var lucroOperacional = receitaLiquida - impostos - taxaCartao - custosOperacionais;
    var lucroLiquido = lucroOperacional - custoIA;
    var margem = receitaBruta > 0 ? Math.round((lucroLiquido / receitaBruta) * 1000) / 10 : 0;

    return {
      success: true,
      data: {
        month: month,
        receitaBruta: Math.round(receitaBruta * 100) / 100,
        cancelamentos: Math.round(cancelamentos * 100) / 100,
        receitaLiquida: Math.round(receitaLiquida * 100) / 100,
        impostos: Math.round(impostos * 100) / 100,
        taxRate: taxRate,
        taxaCartao: Math.round(taxaCartao * 100) / 100,
        cardFeeRate: cardFeeRate,
        custosOperacionais: Math.round(custosOperacionais * 100) / 100,
        custoIA: Math.round(custoIA * 100) / 100,
        lucroOperacional: Math.round(lucroOperacional * 100) / 100,
        lucroLiquido: Math.round(lucroLiquido * 100) / 100,
        margem: margem
      }
    };
  } catch (err) {
    console.error('[FinancialService] getDRE erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 9. getHealthScore
// ============================================================
export async function getHealthScore(clinicId) {
  try {
    var now = new Date();
    var currentMonth = now.toISOString().substring(0, 7);
    var prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 15);
    var prevMonth = prevDate.toISOString().substring(0, 7);

    // Get DRE for current and previous month
    var currentDRE = await getDRE(clinicId, currentMonth);
    var prevDRE = await getDRE(clinicId, prevMonth);

    // Get overview for cancellation data
    var overview = await getFinancialOverview(clinicId, 'month');

    var alerts = [];

    // 1. Margem score (30%)
    var margem = currentDRE.success ? currentDRE.data.margem : 0;
    var margemScore;
    if (margem >= 30) margemScore = 100;
    else if (margem >= 20) margemScore = 80;
    else if (margem >= 10) margemScore = 60;
    else if (margem >= 0) margemScore = 40;
    else margemScore = 0;

    if (margem < 10) alerts.push({ type: 'warning', message: 'Margem de lucro abaixo de 10% — revise custos operacionais' });
    if (margem >= 30) alerts.push({ type: 'success', message: 'Margem de lucro saudavel: ' + margem + '%' });

    // 2. Tendencia receita (25%)
    var currentRev = currentDRE.success ? currentDRE.data.receitaBruta : 0;
    var prevRev = prevDRE.success ? prevDRE.data.receitaBruta : 0;
    var revDelta = prevRev > 0 ? ((currentRev - prevRev) / prevRev) * 100 : 0;
    var tendenciaScore;
    if (revDelta > 5) tendenciaScore = 100;
    else if (revDelta >= -5) tendenciaScore = 70;
    else if (revDelta >= -10) tendenciaScore = 40;
    else tendenciaScore = 0;

    if (revDelta > 5) alerts.push({ type: 'success', message: 'Receita subiu ' + Math.round(revDelta) + '% vs mes anterior' });
    if (revDelta < -10) alerts.push({ type: 'danger', message: 'Receita caiu ' + Math.abs(Math.round(revDelta)) + '% vs mes anterior' });

    // 3. Cancelamento score (20%)
    var totalAppts = overview.success ? (overview.data.totalAppointments + overview.data.totalCancellations) : 0;
    var cancelRate = totalAppts > 0 ? (overview.data.totalCancellations / totalAppts) * 100 : 0;
    var cancelamentoScore;
    if (cancelRate <= 5) cancelamentoScore = 100;
    else if (cancelRate <= 10) cancelamentoScore = 80;
    else if (cancelRate <= 20) cancelamentoScore = 50;
    else cancelamentoScore = 0;

    if (cancelRate > 10) alerts.push({ type: 'warning', message: 'Taxa de cancelamento em ' + Math.round(cancelRate) + '% — acima do ideal' });

    // 4. Ocupacao score (15%) — simplified: based on appointments vs target
    var config = await getFinancialConfig(clinicId);
    var targetAppts = config.data ? config.data.target_monthly_appointments : null;
    var ocupacaoScore = 70; // default if no target
    if (targetAppts && targetAppts > 0 && overview.success) {
      var ocupacao = (overview.data.totalAppointments / targetAppts) * 100;
      if (ocupacao >= 80) ocupacaoScore = 100;
      else if (ocupacao >= 60) ocupacaoScore = 80;
      else if (ocupacao >= 40) ocupacaoScore = 50;
      else ocupacaoScore = 20;
    }

    // 5. ROI Juca score (10%)
    var botPercent = overview.success ? overview.data.revenueBotPercent : 0;
    var roiJucaScore;
    if (botPercent > 50) roiJucaScore = 100;
    else if (botPercent > 30) roiJucaScore = 80;
    else if (botPercent > 10) roiJucaScore = 50;
    else roiJucaScore = 20;

    if (botPercent > 50) alerts.push({ type: 'success', message: 'Receita do robo representa ' + botPercent + '% do faturamento — excelente ROI' });

    // AI cost per appointment
    if (overview.success && overview.data.totalAppointments > 0 && overview.data.aiCost > 0) {
      var costPerAppt = Math.round((overview.data.aiCost / overview.data.totalAppointments) * 100) / 100;
      alerts.push({ type: 'info', message: 'Custo IA por consulta: R$ ' + costPerAppt.toFixed(2) + (costPerAppt < 2 ? ' — extremamente eficiente' : '') });
    }

    // Break-even
    if (currentDRE.success && overview.success && overview.data.avgTicket > 0) {
      var custosTotais = currentDRE.data.custosOperacionais + currentDRE.data.impostos + currentDRE.data.taxaCartao + currentDRE.data.custoIA;
      var breakEven = Math.ceil(custosTotais / overview.data.avgTicket);
      var folga = overview.data.totalAppointments > 0 ? Math.round(((overview.data.totalAppointments - breakEven) / breakEven) * 100) : 0;
      if (folga > 0) {
        alerts.push({ type: 'info', message: 'Break-even: ' + breakEven + ' consultas/mes (voce fez ' + overview.data.totalAppointments + ' — folga de ' + folga + '%)' });
      } else if (breakEven > 0) {
        alerts.push({ type: 'warning', message: 'Break-even: ' + breakEven + ' consultas/mes — voce fez apenas ' + overview.data.totalAppointments });
      }
    }

    var score = Math.round(
      (margemScore * 0.30) +
      (tendenciaScore * 0.25) +
      (cancelamentoScore * 0.20) +
      (ocupacaoScore * 0.15) +
      (roiJucaScore * 0.10)
    );

    return {
      success: true,
      data: {
        score: score,
        breakdown: {
          margem: { score: margemScore, weight: 0.30, value: margem },
          tendencia: { score: tendenciaScore, weight: 0.25, value: Math.round(revDelta * 10) / 10 },
          cancelamento: { score: cancelamentoScore, weight: 0.20, value: Math.round(cancelRate * 10) / 10 },
          ocupacao: { score: ocupacaoScore, weight: 0.15 },
          roiJuca: { score: roiJucaScore, weight: 0.10, value: botPercent }
        },
        alerts: alerts
      }
    };
  } catch (err) {
    console.error('[FinancialService] getHealthScore erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 10. getFinancialConfig
// ============================================================
export async function getFinancialConfig(clinicId) {
  try {
    var { data, error } = await sb
      .from('clinic_financial_config')
      .select('*')
      .eq('clinic_id', clinicId)
      .maybeSingle();

    if (error) return { success: false, error: error.message };

    // Create default if not exists
    if (!data) {
      var { data: created, error: createErr } = await sb
        .from('clinic_financial_config')
        .insert({ clinic_id: clinicId })
        .select()
        .single();

      if (createErr) return { success: false, error: createErr.message };
      return { success: true, data: created };
    }

    return { success: true, data: data };
  } catch (err) {
    console.error('[FinancialService] getFinancialConfig erro:', err);
    return { success: false, error: err.message };
  }
}

// ============================================================
// 11. updateFinancialConfig
// ============================================================
export async function updateFinancialConfig(clinicId, configData) {
  try {
    // Ensure config exists first
    await getFinancialConfig(clinicId);

    var updates = {};
    if (configData.default_appointment_value !== undefined) updates.default_appointment_value = configData.default_appointment_value;
    if (configData.tax_regime !== undefined) updates.tax_regime = configData.tax_regime;
    if (configData.tax_rate !== undefined) updates.tax_rate = configData.tax_rate;
    if (configData.card_fee_rate !== undefined) updates.card_fee_rate = configData.card_fee_rate;
    if (configData.target_monthly_revenue !== undefined) updates.target_monthly_revenue = configData.target_monthly_revenue;
    if (configData.target_monthly_appointments !== undefined) updates.target_monthly_appointments = configData.target_monthly_appointments;

    var { data, error } = await sb
      .from('clinic_financial_config')
      .update(updates)
      .eq('clinic_id', clinicId)
      .select()
      .single();

    if (error) return { success: false, error: error.message };
    return { success: true, data: data };
  } catch (err) {
    console.error('[FinancialService] updateFinancialConfig erro:', err);
    return { success: false, error: err.message };
  }
}
