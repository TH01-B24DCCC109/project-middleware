# Dự án Demo: Tích hợp Đồng bộ vs Bất đồng bộ (Academic - Finance)

## Luồng đồng bộ Academic → Finance

Mở hai terminal tại thư mục gốc `project-middleware`:

```bash
# Terminal 1: Finance REST
cd finance
npm install
npm start

# Terminal 2: Academic REST
cd academic
npm install
npm start
```

Gửi yêu cầu thử:

```bash
curl -X POST http://localhost:3001/api/academic/tuition/sync \
  -H "Content-Type: application/json" \
  -H "x-request-id: demo-request-001" \
  -d '{"studentId":"SV001","term":"HK1-2026","amount":5000000}'
```

Academic gọi Finance tại `http://localhost:3002` theo mặc định; có thể đổi bằng `FINANCE_URL`.
Đặt `REQUEST_TIMEOUT_MS` để cấu hình timeout (mặc định 3000 ms) và `RETRY_COUNT` để cấu hình số lần thử lại (mặc định 2). Các lỗi mạng, timeout và phản hồi HTTP 408, 429 hoặc 5xx được thử lại; lỗi 4xx khác được trả về ngay. Circuit breaker mở 30 giây sau ba yêu cầu liên tiếp thất bại. Gửi lại cùng `x-request-id` để Finance nhận diện yêu cầu trùng và không tạo khoản học phí mới.

Lịch sử giao dịch đồng bộ được lưu tại `shared/system_logs.json`, danh sách học phí tại `finance/tuition_records.json`.

Chạy kiểm thử đồng bộ bằng `npm test` trong từng thư mục `academic` và `finance`.

## 1. Hướng dẫn khởi chạy hạ tầng (RabbitMQ)
Mở Terminal tại thư mục gốc `project-middleware` và chạy:
```bash
docker-compose up -d