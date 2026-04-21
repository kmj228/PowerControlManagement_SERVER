# IoT 장비 관리 서버

WIZ550S2E 기반 전원 제어 장비를 웹 브라우저에서 관리하는 서버 프로그램입니다.

## 배포 (사용자에게 전달)

### 1. EXE 빌드

[Node.js](https://nodejs.org/) 18 이상이 설치된 상태에서 루트 폴더의 `make_dist.bat` 실행

```
make_dist.bat 실행
  → npm install + pkg 빌드
  → dist/DeviceManager.exe 생성
```

### 2. 배포 파일 전달

`dist/` 폴더 전체를 사용자에게 전달합니다.

```
dist/
├── DeviceManager.exe   ← 독립 실행 파일 (Node.js 불필요)
└── start.bat           ← MariaDB 설치 안내 후 서버 실행
```

---

## 사용자 실행 방법

1. `dist/` 폴더를 원하는 위치에 복사
2. `start.bat` 더블클릭
3. 브라우저에서 `https://localhost:3000` 접속

---

## 첫 실행 안내

1. 초기 계정으로 로그인
   - 아이디: `admin` / 비밀번호: `admin1234`
   - 로그인 후 반드시 비밀번호를 변경하세요
2. 설정 메뉴에서 순서대로 설정
   - **DB 설정** — MariaDB 접속 정보 입력 (선택)
   - **장비 등록** — 장비 목록 → 추가 버튼으로 WIZ550S2E 등록
   - **인증서 설치** — HTTPS 경고 제거

---

## MariaDB 설정 (로그 기능 사용 시)

[MariaDB](https://mariadb.org/download) 설치 후 아래 절차가 필요합니다.

**인증 방식 변경** (mysql2 라이브러리 호환을 위해 필수)

```sql
ALTER USER 'root'@'localhost'
  IDENTIFIED VIA mysql_native_password
  USING PASSWORD('비밀번호');
FLUSH PRIVILEGES;
```

**서버 DB 설정 화면 입력값**

| 항목 | 값 |
|------|----|
| 호스트 | localhost |
| 포트 | 3306 |
| 아이디 | root |
| 비밀번호 | 위에서 설정한 비밀번호 |
| DB명 | 원하는 이름 입력 |

---

## 주요 기능

- WIZ550S2E 채널별 전원 ON / OFF / RESET 제어
- 실시간 상태 모니터링 (WebSocket, 10초 주기)
- 연결 상태 4단계 표시 — 연결됨 / 타임아웃 / 연결 해제 / 미연결
- MariaDB 로그 기록 / 검색 / CSV 내보내기
- 다중 사용자 및 역할 구분 (관리자 / 일반 사용자)
- HTTPS 자동 인증서 생성

## 기본 포트

| 용도 | 포트 |
|------|------|
| 웹 (HTTPS) | 3000 |
| 장비 TCP 연결 | 5002 |

TCP 포트는 설정 메뉴에서 변경 가능합니다.

---

## 개발자 실행 방법

```bash
cd source
npm install
node server.js
```

## 파일 구조

```
├── source/             # 소스 코드
│   ├── server.js       # 서버 메인 (HTTP/WebSocket/TCP)
│   ├── index.html      # 프론트엔드 UI
│   ├── app.js          # 프론트엔드 로직
│   └── package.json
├── dist/
│   └── start.bat       # 사용자 실행 파일
└── make_dist.bat       # EXE 빌드 스크립트
```
