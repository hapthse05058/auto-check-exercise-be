# Template lớp Basic — tài liệu mẫu để test

Danh sách Google Doc mẫu của khóa **Basic**, dùng để kiểm thử tay (manual test)
sau mỗi lần cập nhật chức năng chấm bài. Mỗi template ứng với một `classType`
trong collection `classes` (xem [docTables.js](../backend/lib/doc/docTables.js)).

## Ba template hiện hành

| `classType` | Template | Link |
|---|---|---|
| `basic_since_01042026` | Basic class: NEW TỪ THÁNG 4/2026 | https://docs.google.com/document/d/1m_d7z5LjO3ozRZUgCs-GdBx8YrdJa33_TmZ3Vvd0mUE/edit?usp=sharing |
| `basic_since_20072026` | Basic class: ÁP DỤNG TỪ 20/07/2026 | https://docs.google.com/document/d/1CokWN2cZObmHCpNwB4WnIwnKRbFrcOdBsIQdXStoO9A/edit?tab=t.ysuoplcwfqou |
| `basic_before_31032026` | Áp dụng cho lớp KG trước 31.03.2026 | https://docs.google.com/document/d/1QgQR5XzGa1gR25C9BTA3g1DgZAVF7E72V2_1SHyxg28/edit?tab=t.ysuoplcwfqou |
| `ielts` | '' | https://docs.google.com/document/d/1QqM4Blpyihp8NeDvf6b-DMd4sBqSZlJf27ea9QFfuxM/edit?tab=t.prsob13xlidh |
| `HS` | '' | https://docs.google.com/document/d/1lkaPSSkX2iRZpdMPtdB9rn9MRor8R2_4V_TS9Jsp8Yw/edit?usp=sharing |

## Vì sao phải test cả ba

`getTableIndexOfExercise(tabName, classType)` trong
[docTables.js](../backend/lib/doc/docTables.js) chia hai nhánh bố cục bảng:

- `basic_since_01042026` và `basic_since_20072026` → dùng `TAB_NAME_LIST`
  (ví dụ BUỔI 02 → bảng `[5, 6]`).
- `basic_before_31032026` → dùng
  `TAB_NAME_LIST_FOR_BASIC_CLASS_BEFORE_31032026` (BUỔI 02 → bảng `[4, 5]`).

Nghĩa là: một thay đổi ở phần đọc/ghi bảng chỉ chạy đúng trên template mới vẫn
có thể vỡ ở template lớp KG cũ. Sau khi sửa code liên quan tới đọc bảng, ghi
nhận xét, hay nhận diện tab, nên chạy thử **ít nhất một buổi trên mỗi nhánh**:
một trong hai template "since", cộng với template `basic_before_31032026`.

Các tab bài học đều theo dạng `BUỔI XX`; danh sách buổi được khai báo trong
`TAB_NAME_LIST*`. Bảng cuối trong mỗi `tableIndex` là bảng nhận xét chung của
giáo viên.

## Quy ước khi test

- **Không chấm trực tiếp lên ba file trên** — đây là template gốc. Tạo bản copy
  (File → Make a copy) rồi trỏ `ggDocLink` của lớp test sang bản copy.
- Service account của backend (`firebase-service-account.json` / biến môi trường
  Google) phải có quyền đọc-ghi trên bản copy, nếu không job chấm sẽ lỗi quyền.
- Khi thêm một template Basic mới: thêm `classType` vào
  [docTables.js](../backend/lib/doc/docTables.js), map nó vào đúng nhánh
  `TAB_NAME_LIST*`, và bổ sung một dòng vào bảng ở trên.
