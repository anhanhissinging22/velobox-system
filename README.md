# VELOBOX Smart Locker

Prototype vận hành chạy trên Node.js và SQLite cục bộ. Giao diện được phục vụ từ `velobox_system.html`; xử lý nghiệp vụ và dữ liệu được quản lý bởi `server.mjs`. Database mặc định là `velobox.sqlite` trong thư mục dự án và không được đưa lên Git.

## Lưu source trên GitHub, chạy ứng dụng tại máy này

GitHub chỉ lưu mã nguồn và tài liệu. Backend cùng SQLite vẫn chạy trên máy chủ local; GitHub Pages không chạy Node.js và không kết nối được tới SQLite trên máy này.

Để chạy cho các thiết bị trong cùng mạng nội bộ:

1. Cài Node.js có hỗ trợ `node:sqlite` (Node.js 22 trở lên).
2. Mở thư mục dự án trong VS Code.
3. Chạy `start-local-hosting.bat`.
4. Trên máy chủ, mở `http://127.0.0.1:4173/`. Trên thiết bị khác cùng mạng Wi-Fi/LAN, mở `http://<địa-chỉ-IPv4-của-máy-chủ>:4173/` (xem địa chỉ bằng lệnh `ipconfig`).

Máy chủ và thiết bị khách cần ở cùng mạng nội bộ; không cấu hình mở cổng này trực tiếp ra Internet. Dữ liệu người dùng phát sinh được lưu trong `velobox.sqlite` trên máy chủ này.

## Chạy chỉ trên máy hiện tại

1. Cài Node.js có hỗ trợ `node:sqlite` (Node.js 22 trở lên).
2. Mở thư mục dự án trong VS Code.
3. Chạy `node server.mjs` trong terminal.
4. Mở `http://127.0.0.1:4173/`.

Có thể đặt `VELOBOX_DB` để lưu database ở một đường dẫn local khác. Tài khoản Admin đầu tiên được tạo ở màn hình thiết lập; tài khoản mới do Admin tạo có mật khẩu ban đầu `12345678`.

## Vai trò

- Admin VELOBOX: cấu hình hệ thống, tài khoản, RBAC, khu dân cư và tích hợp.
- Nhân viên vận hành: xử lý đơn, sự cố, quá hạn, webhook và hồ sơ nghiệp vụ.
- Quản trị đối tác giao hàng: theo dõi đơn trong phạm vi được gán và tạo tài khoản Shipper thuộc phạm vi đó.
- Shipper: xem đơn được giao, mở QR VELO-Scan và cập nhật luồng giao nhận.
- Người nhận: theo dõi đơn, xem OTP trong mục Thông báo, thanh toán mô phỏng và xác nhận nhận hàng.
- Quản lý điểm đặt/BQL: theo dõi trạm, cư dân, đơn và xử lý vận hành trong khu dân cư được gán.
- Tài chính: quản lý khoản thanh toán, hóa đơn nội bộ và đối soát.
- Kỹ thuật viên: theo dõi trạm/ngăn, sự cố và phiếu bảo trì.

Vai trò `BUILDING_ADMIN` cũ được nâng thành `SITE_MANAGER` khi backend khởi động. Mục sidebar được lọc theo vai trò và API cũng kiểm tra quyền truy cập.

## Các luồng Use Case

- UC01–07: tài khoản, phân quyền và phạm vi khu dân cư.
- UC08–12: tạo đơn nội bộ, nhận cập nhật qua webhook và ghi lỗi ánh xạ.
- UC13–18: quản lý trạm/ngăn và trạng thái thiết bị; yêu cầu remote unlock được ghi log.
- UC19–26: QR mở tủ có hiệu lực 20 giây, ràng buộc người giao/đơn/ngăn/trạm.
- UC27–35: giao hàng, OTP, thanh toán và giải phóng ngăn khi nhận.
- UC36–46: quá hạn, yêu cầu gia hạn, thu hồi và trả lại kiện hàng.
- UC47–52: sự cố, thông báo trong ứng dụng, lịch sử đơn và audit log.
- UC53–59: cấu hình tích hợp, theo dõi lỗi webhook, đối soát và quyết toán.

Nguồn nghiệp vụ chi tiết là `VELOBOX_UML_59_Use_Cases.pdf` và các file `.puml` tương ứng.

## Tích hợp webhook đơn hàng

Endpoint: `POST /api/webhooks/orders`. Cấu hình một integration có `kind` là `webhook`, `carrier` hoặc `ecommerce`, đặt shared secret, sau đó bật cấu hình. Gửi các header `X-VeloBox-Secret` và `X-VeloBox-Source` cùng JSON có `external_order_id`, `recipient`, `neighborhood_id`, `resident_id`, `assigned_shipper_id` và `amount`. Đơn chỉ được nhận nếu người nhận/shipper thuộc khu dân cư và còn ngăn trống; lỗi ánh xạ được lưu ở mục **Lỗi đồng bộ**.

## Mô phỏng và giới hạn tích hợp

- Ba lần nhấn vào QR mô phỏng lần quét VELO-Scan và xác nhận đồng thời khối lượng/cửa đóng. QR hết hạn sau 20 giây hoặc sau khi dùng.
- Thanh toán, e-invoice, thông báo trong ứng dụng, đối soát và quyết toán lưu được trạng thái trong SQLite. Nghiệp vụ thanh toán và hóa đơn hiện chạy ở chế độ mô phỏng nội bộ.
- Chưa kết nối bộ điều khiển locker/VELO-Scan vật lý, cổng thanh toán, nhà cung cấp hóa đơn điện tử, SMS/email/push, hoặc hệ thống vận chuyển/thương mại điện tử bên ngoài. Remote unlock hiện chỉ ghi nhận yêu cầu và audit.
- API key, mật khẩu và database chỉ dùng ở máy local; không commit `velobox.sqlite` hoặc thông tin bí mật lên GitHub.

## Tài liệu mô hình

`README.txt` mô tả gói sơ đồ; các mô-đun PlantUML là `01_accounts_roles.puml` đến `08_integration_reconciliation.puml`, kèm ảnh PNG và bản PDF gộp.
