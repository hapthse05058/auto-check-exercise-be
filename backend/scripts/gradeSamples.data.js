// Bộ đề kiểm thử cho `gradeSample.js`, nhóm theo buổi.
//
// Mỗi câu là [đề tiếng Việt, đáp án học sinh, lỗi đã gài]. `null` ở ô thứ ba
// nghĩa là câu ĐÚNG, cố tình trộn vào để đo "bắt lỗi oan" — chỉ số quan trọng
// nhất, vì một bộ chấm gắt tới mức bắt sai cả câu đúng thì học viên mất lòng
// tin vào toàn bộ phần chữa.
//
// Phần lớn câu KHÔNG có trong tài liệu buổi, nên đây là phép thử "áp dụng quy
// tắc", không phải "chép đáp án mẫu". Câu nào lấy nguyên văn từ bài làm thật
// của học viên thì giữ đúng chính tả và viết thường như bản gốc.

const lesson02 = [
  [
    "Tôi học Tiếng Anh hàng ngày.",
    "I learn English everyday.",
    "everyday → every day",
  ],
  [
    "Bố tôi rất yêu gia đình của chúng tôi.",
    "My father love our family very much.",
    "love → loves",
  ],
  [
    "Người phụ nữ đó luôn tốt bụng và hào phóng.",
    "That woman always kind and generous.",
    "thiếu VL is",
  ],
  [
    "Anh trai tôi đang nói chuyện với bạn của anh ấy.",
    "My brother is talk with his friend.",
    "is talk → is talking",
  ],
  [
    "Những đứa trẻ đang chào tạm biệt ông của chúng.",
    "The children is saying goodbye to their grandfather.",
    "is → are",
  ],
  [
    "Tôi đã biết người đó được ba năm rồi.",
    "I know that person for three years.",
    "know → have known (HTHT)",
  ],
  [
    "Bà tôi đã sống một mình được khoảng hai năm rồi.",
    "My grandmother has lived alone for about two years.",
    null,
  ],
  [
    "Tôi đã (liên tục) chờ bạn tôi được khoảng một tiếng rồi.",
    "I have waited my friend continuously for about one hour.",
    "have been waiting; wait for; bỏ continuously",
  ],
  [
    "Tôi đã gặp bạn thân của tôi ngày hôm qua.",
    "I meet my best friend yesterday.",
    "meet → met",
  ],
  [
    "Bố mẹ tôi đã tổ chức sinh nhật cho tôi tuần trước.",
    "My parents held a birthday party for me last week.",
    null,
  ],
  [
    "Tôi đã học bài cùng chị tôi vào tối qua.",
    "I studied with my sister in last night.",
    "bỏ in trước last night",
  ],
  [
    "Lúc 8 giờ tối hôm qua, chồng của cô ấy đang kể một câu chuyện vui.",
    "At 8 pm yesterday, her husband is telling a funny story.",
    "is → was (QKTD)",
  ],
  [
    "Khi anh trai tôi về nhà vào tối qua, tôi đang học bài.",
    "When my brother came home last night, I was study.",
    "was study → was studying",
  ],
  [
    "Tôi đã hoàn thành bài tập về nhà của tôi trước khi tôi đi ngủ ngày hôm qua.",
    "I have finished my homework before I went to bed yesterday.",
    "have → had (QKHT)",
  ],
  [
    "Đến 10 giờ tối hôm qua, bố tôi đã làm việc liên tục được 8 tiếng rồi.",
    "By 10 pm yesterday, my father had been work continuously for 8 hour.",
    "been work → been working; bỏ continuously; hour → hours",
  ],
];

// Buổi 03: các thì tương lai, be going to, thể bị động, verb linking.
const lesson03 = [
  [
    "Ngày mai, tôi sẽ gặp chị gái tôi.",
    "Tomorrow, I will met my sister.",
    "will + Vbare → meet",
  ],
  [
    "Cô ấy sẽ gọi bạn vào ngày mai.",
    "She will call for you tomorrow.",
    "dư for sau call",
  ],
  [
    "Tháng sau, tôi sẽ đi du lịch tới Hạ Long.",
    "Next month, I will travel Ha Long.",
    "travel to Ha Long",
  ],
  [
    "Lúc 8 giờ tối mai, anh trai tôi sẽ đang đi chơi với bạn của anh ấy.",
    "At 8 pm tomorrow, my brother will go out with his friend.",
    "TLTD: will be going out",
  ],
  [
    "Tôi sẽ hoàn thành bài tập về nhà của tôi trước 8 giờ tối mai.",
    "I will have finish my homework before 8 pm tomorrow.",
    "will have finished",
  ],
  ["Tôi sẽ đi đá bóng tối nay.", "I am going to play soccer tonight.", null],
  [
    "Tôi sẽ đi thăm bạn vào ngày mai.",
    "I am going visit friend tomorrow.",
    "thiếu to; friend → you",
  ],
  [
    "Tiếng Anh được dạy ở phòng học này.",
    "English is teach in this classroom.",
    "is taught (HTĐ bị động)",
  ],
  [
    "Các học sinh được giúp đỡ bởi giáo viên.",
    "The students is helped by the teacher.",
    "is → are",
  ],
  [
    "Căn phòng đang được dọn dẹp bởi chị tôi.",
    "The room is cleaning by my sister.",
    "is being cleaned (HTTD bị động)",
  ],
  [
    "Người đàn ông đó đã được giới thiệu hôm qua.",
    "That man was introduce yesterday.",
    "was introduced",
  ],
  [
    "Người phụ nữ đó rất thân thiện và tốt bụng.",
    "That woman very friendly and kind.",
    "thiếu VL is",
  ],
  ["Người đàn ông đó là một bác sĩ.", "That man is a doctor.", null],
  [
    "Cô gái đó trông rất lịch sự.",
    "That girl looks very politely.",
    "VL + adj: polite",
  ],
  ["Bài hát này nghe hay.", "This song sounds well.", "VL + adj: good"],
];

// Buổi 04: khẳng định/phủ định/nghi vấn, FANBOYS, danh từ, cụm danh từ, bảo
// toàn "s". Câu 16-23 là bài làm THẬT của học viên, giữ nguyên văn — trong đó
// có 4 câu đúng ngữ pháp nhưng SAI NGHĨA so với đề (phép thử khó nhất).
const lesson04 = [
  ["Tôi thích bóng chày.", "I like baseball.", null],
  [
    "Tôi không thích bóng chày.",
    "I not like baseball.",
    "thiếu trợ động từ don't",
  ],
  [
    "Bạn có thích bóng chày không?",
    "Do you likes baseball?",
    "sau Do dùng Vbare like",
  ],
  [
    "Cô ấy đang nghe nhạc lúc 8 giờ tối qua.",
    "She was listening music at 8 pm yesterday.",
    "listen to music",
  ],
  [
    "Cô ấy đang không nghe nhạc lúc 8 giờ tối qua.",
    "She didn't listening to music at 8 pm yesterday.",
    "phủ định QKTD: wasn't listening",
  ],
  [
    "Cô ấy có đang nghe nhạc lúc 8 giờ tối qua không?",
    "Did she listening to music at 8 pm yesterday?",
    "nghi vấn QKTD: Was she listening",
  ],
  ["Chúng ta có thể chơi bóng đá ở đây.", "We can play football here.", null],
  [
    "Chúng ta không thể chơi bóng đá ở đây.",
    "We don't can play football here.",
    "can't play, không mượn don't",
  ],
  [
    "Chúng ta có thể chơi bóng đá ở đây không?",
    "Do we can play football here?",
    "Can we play football here?",
  ],
  [
    "Họ đã xem TV, và họ đã đọc báo hôm qua.",
    "They watched TV, and they read newspaper yesterday.",
    "newspaper cần NTNS",
  ],
  [
    "Họ đã không xem TV, nhưng họ đã đọc báo hôm qua.",
    "They didn't watched TV, but they read the newspaper yesterday.",
    "sau didn't dùng Vbare watch",
  ],
  [
    "Họ đã đọc báo hôm qua phải không?",
    "Did they readed the newspaper yesterday?",
    "sau Did dùng Vbare read",
  ],
  [
    "Trận đấu thú vị, nên chúng tôi đã xem nó.",
    "The match was interesting, so we watch it.",
    "watch → watched",
  ],
  [
    "Trận đấu không thú vị, nên chúng tôi đã không xem nó.",
    "The match wasn't interesting, so we didn't watched it.",
    "sau didn't dùng Vbare watch",
  ],
  [
    "Trận đấu có thú vị không?",
    "Did the match interesting?",
    "Was the match interesting?",
  ],
  ["Tôi học Tiếng Anh hàng ngày.", "I study English", "thiếu every day"],
  [
    "Cô ấy đọc sách mỗi tối.",
    "She read book every night",
    "reads; books (NTNS)",
  ],
  [
    "Tôi đang học Tiếng Anh bây giờ.",
    "I'm study English nowadays",
    "am studying; now chứ không phải nowadays",
  ],
  [
    "Cô ấy đang đọc sách bây giờ.",
    "she's watching tv at the moment",
    "SAI NGHĨA: phải là reading a book",
  ],
  [
    "Tôi đã học Tiếng Anh được 5 năm.",
    "I've studied English for 4 years",
    "SAI SỐ LIỆU: 5 years",
  ],
  [
    "Cô ấy đã đọc được 30 quyển sách.",
    "she've read 20 books",
    "she has read; SAI SỐ LIỆU: 30 books",
  ],
  [
    "Tôi đã học Tiếng Anh liên tục được 2 tiếng.",
    "I has been learning english for 2 hours",
    "I have been learning",
  ],
  [
    "Cô ấy đã đọc sách liên tục được 30 phút.",
    "She reading book for 20 minutes",
    "has been reading; books; SAI SỐ LIỆU: 30 minutes",
  ],
  [
    "Một chiếc máy tính - 2 chiếc máy tính",
    "a computer - two computer",
    "two computers",
  ],
  [
    "Một cái điện thoại - 2 cái điện thoại",
    "an phone - two phones",
    "a phone (phụ âm)",
  ],
  ["Một người - 5 người", "a person - five persons", "five people"],
  ["Một người đàn ông - 5 người đàn ông", "a man - five mans", "five men"],
  ["1 con chuột - 5 con chuột", "a mouse - five mouses", "five mice"],
  ["Môn toán", "math", null],
  ["Cát", "a sand", "sand không đếm được, bỏ a"],
  ["Nước", "water", null],
  ["Tiền", "moneys", "money không đếm được"],
  ["Tin tức - 1 mẩu tin tức", "news - 1 piece news", "1 piece of news"],
  [
    "Cà phê - 5 cốc cà phê",
    "cafe - 5 cups of cafe",
    "coffee chứ không phải cafe",
  ],
  ["Gạo - 1 túi gạo", "rice - a bag rice", "a bag of rice"],
  [
    "Anh ấy có công việc tốt, vì anh ấy làm việc chăm chỉ.",
    "He has a good job, because he works hard.",
    "có dấu phẩy → dùng , for",
  ],
  [
    "Tôi muốn đi ra ngoài, nhưng trời đang mưa.",
    "I want to go out, but the sky is raining.",
    "thời tiết dùng S giả it",
  ],
  ["Tôi mệt, nên tôi muốn nghỉ ngơi.", "I am tired, so I want to rest.", null],
  [
    "Những quyển sách ở trên giá sách là sách của tôi.",
    "Books on the bookshelf is my books.",
    "The books; are",
  ],
  [
    "Những chiếc máy tính mới trong thư viện đều rất đắt.",
    "Computers new in the library are expensive.",
    "New computers (adj trước N)",
  ],
  [
    "Những chiếc cửa sổ trong căn phòng này đều rất mới.",
    "Windows in the room is very new.",
    "The windows; are",
  ],
  [
    "Một nhân viên mới trong công ty đang làm việc rất chăm chỉ.",
    "A new employee in the company is work so hard.",
    "is working",
  ],
  [
    "Những học sinh ở trong lớp này luôn đi học đúng giờ.",
    "Students in the class always are go to school on time.",
    "bỏ are",
  ],
  [
    "Chị gái của tôi thích nghe nhạc.",
    "My sister like listening to music.",
    "likes",
  ],
  [
    "Các học sinh chơi cờ vua trong lớp.",
    "The students play chess in the class.",
    null,
  ],
  [
    "Các nhân viên trong công ty làm việc chăm chỉ.",
    "The employees in the company works hard.",
    "work (S số nhiều)",
  ],
  [
    "Nước rất tốt cho sức khỏe của bạn.",
    "Water good for your health.",
    "thiếu VL is",
  ],
  [
    "Không khí ở Đà Lạt trong lành và sạch sẽ.",
    "The air in Đà Lạt fresh and clean.",
    "thiếu VL is",
  ],
];

// Buổi 05: thì quá khứ, đại từ/sở hữu, trật tự từ, danh từ xác định và không
// xác định.
const lesson05 = [
  [
    "Chúng tôi đã chơi bóng đá hôm qua.",
    "We play football yesterday.",
    "played (QKĐ)",
  ],
  ["Anh ấy đã xem TV tối qua.", "He watched TV last night.", null],
  [
    "Chúng tôi đang chơi bóng đá lúc 8h tối qua.",
    "We was playing football at 8 pm yesterday.",
    "were playing",
  ],
  [
    "Anh ấy đang xem TV lúc 7h tối qua.",
    "He was watch TV at 7 pm yesterday.",
    "was watching",
  ],
  [
    "Tính đến 2024, chúng tôi đã chơi bóng đá được 3 năm.",
    "By 2024, we have played football for three years.",
    "had played (QKHT)",
  ],
  [
    "Tính đến 2024, anh ấy đã xem được 5 bộ phim.",
    "By 2024, he had watch five movies.",
    "had watched",
  ],
  [
    "Tính đến 8h tối qua, chúng tôi đã chơi bóng đá (liên tục) được 2 tiếng.",
    "By 8 pm yesterday, we had been play football continuously for 2 hour.",
    "been playing; bỏ continuously; hours",
  ],
  [
    "Tính đến 9h tối qua, anh ấy đã xem TV (liên tục) được 2 tiếng.",
    "By 9 pm yesterday, he has been watching TV for 2 hours.",
    "had been watching (QKHTTD)",
  ],
  [
    "Cô ấy đã bị mất điện thoại, nên cô ấy đã mượn cái của tôi.",
    "She lost her phone, so she borrowed my.",
    "mine / my phone",
  ],
  [
    "Chúng tôi không thể giao đơn hàng của bạn trước thứ 6 tuần này.",
    "We can not deliver order your before Friday this week.",
    "your order (trật tự từ)",
  ],
  [
    "Tôi có thể chỉ cho bạn đường tới SEC.",
    "I can show you street to SEC.",
    "the way",
  ],
  [
    "Nhà hàng này nổi tiếng vì đầu bếp của nó.",
    "The restaurant is famous because its chef.",
    "famous for its chef",
  ],
  [
    "Bộ phận marketing của chúng ta rất xuất sắc.",
    "Our department marketing is very excellent.",
    "marketing department",
  ],
  [
    "Nước rất quan trọng cho sức khỏe của chúng ta.",
    "Water important for our health.",
    "thiếu VL is",
  ],
  ["Tiền không là tất cả.", "Money are not all.", "money không đếm được → is"],
  [
    "Tôi thích đọc sách và uống trà.",
    "I like reading book and drinking tea.",
    "books (nói chung → số nhiều)",
  ],
  [
    "Rượu không tốt cho sức khỏe của bạn.",
    "Alcohol is not good for your health.",
    null,
  ],
  ["Hãy trả lại tôi quyển sách.", "Give I back the book.", "give me back"],
  [
    "Bạn có thể ăn cái pizza ở trong tủ lạnh.",
    "You can eat pizza in the refrigerator.",
    "the pizza (đã xác định)",
  ],
  [
    "Chàng trai bên cạnh bạn là bạn trai của tôi.",
    "Boy next to you is my boyfriend.",
    "The boy",
  ],
  [
    "Món salad ở trong bếp không ngon.",
    "salad in the kitchen is not tasty.",
    "The salad",
  ],
  [
    "Cô gái ở đằng kia rất xinh.",
    "The girl over there is very beautiful.",
    null,
  ],
];

/** Chuyển bộ đề thô thành dạng có STT, giống hệt cách server đánh số group. */
function normalize(rows) {
  return rows.map(([question, answer, expect], i) => ({
    stt: i + 1,
    question: `${i + 1}. ${question}`,
    answer: `→ ${answer}`,
    expect,
  }));
}

const SAMPLES = {
  lesson02: normalize(lesson02),
  lesson03: normalize(lesson03),
  lesson04: normalize(lesson04),
  lesson05: normalize(lesson05),
};

module.exports = { SAMPLES };
