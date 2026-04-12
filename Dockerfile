# 1. Sử dụng Node.js bản nhẹ để tiết kiệm dung lượng
FROM node:20-slim

# 2. Tạo thư mục làm việc trong container
WORKDIR /usr/src/app

# 3. Copy các file định nghĩa thư viện
COPY package*.json ./

# 4. Cài đặt thư viện (chỉ cài những cái cần cho production)
RUN npm install --only=production

# 5. Copy toàn bộ mã nguồn vào container
COPY . .

# 6. Mở cổng 8080 (Đây là cổng mặc định của Cloud Run)
EXPOSE 8080

# 7. Lệnh khởi chạy server
CMD [ "node", "server.js" ]