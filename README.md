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

## Luồng bất đồng bộ Academic → RabbitMQ (producer)

Khởi động RabbitMQ theo hướng dẫn hạ tầng bên dưới, sau đó chạy Academic:

```bash
cd academic
npm install
npm start
```

Gửi yêu cầu vào queue:

```bash
curl -X POST http://localhost:3001/api/academic/tuition/async \
  -H "Content-Type: application/json" \
  -H "x-request-id: demo-async-001" \
  -d '{"studentId":"SV001","term":"HK1-2026","amount":5000000}'
```

Academic mặc định kết nối `amqp://localhost:5672` và tạo queue bền vững `tuition.create`. Có thể cấu hình bằng `AMQP_URL` và `TUITION_QUEUE`. Message được gửi ở chế độ persistent; API trả HTTP 202 sau khi RabbitMQ xác nhận publisher confirm. Kiểm tra message trong RabbitMQ Management UI tại `http://localhost:15672` (thông tin đăng nhập mặc định của image là `guest` / `guest`). Phần này chỉ publish; Finance Consumer thuộc công việc 3.

Chạy kiểm thử bằng `npm test` trong từng thư mục `academic` và `finance`.

## 1. Hướng dẫn khởi chạy hạ tầng (RabbitMQ)
Mở Terminal tại thư mục gốc `project-middleware` và chạy:
```bash
docker-compose up -d