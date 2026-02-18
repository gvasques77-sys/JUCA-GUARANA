# ======================================================
# TESTE DO ENDPOINT /process
# ======================================================

# URL do servidor (local ou produção)
$URL = "http://localhost:3000/process"
# $URL = "https://agentservice-production.up.railway.app/process"

# Dados do teste
$body = @{
    correlation_id = "test_001"
    clinic_id = "09e5240f-9c26-47ee-a54d-02934a36ebfd"
    from = "5566996194231"
    message_text = "Oi, quero marcar consulta amanhã de manhã"
} | ConvertTo-Json -Compress

# Fazer requisição
Write-Host "🚀 Enviando requisição..." -ForegroundColor Cyan
Write-Host "URL: $URL" -ForegroundColor Gray
Write-Host "Body: $body" -ForegroundColor Gray
Write-Host ""

try {
    $response = Invoke-RestMethod -Uri $URL -Method Post -Body $body -ContentType "application/json"
    
    Write-Host "✅ SUCESSO!" -ForegroundColor Green
    Write-Host ""
    Write-Host "Resposta:" -ForegroundColor Yellow
    $response | ConvertTo-Json -Depth 10
    
} catch {
    Write-Host "❌ ERRO!" -ForegroundColor Red
    Write-Host ""
    Write-Host "Status Code:" $_.Exception.Response.StatusCode.value__ -ForegroundColor Red
    Write-Host "Mensagem:" $_.Exception.Message -ForegroundColor Red
}
