<div align="center">

# 전원 제어 장치 관리 서버

**WIZ550S2E 기반 전원 제어 장비 원격 관리 플랫폼**

[![Node.js](https://img.shields.io/badge/Node.js-339933?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![MariaDB](https://img.shields.io/badge/MariaDB-003545?style=flat-square&logo=mariadb&logoColor=white)](https://mariadb.org/)
[![WebSocket](https://img.shields.io/badge/WebSocket-010101?style=flat-square&logo=socket.io&logoColor=white)]()
[![HTTPS](https://img.shields.io/badge/HTTPS-FF6B35?style=flat-square&logo=letsencrypt&logoColor=white)]()
[![Windows](https://img.shields.io/badge/Windows-0078D4?style=flat-square&logo=windows&logoColor=white)]()

</div>

---

<table align="center">
  <tr>
    <td align="center"><img src="https://github.com/kmj228.png" width="100px;"/><br /><sub><b>김민재</b></sub><br /><a href="https://github.com/kmj228">kmj228</a></td>
  </tr>
  <tr>
    <td align="center">개발</td>
  </tr>
</table>

---

## 목차

- [프로젝트 소개](#프로젝트-소개)
- [주요 기능](#주요-기능)
- [기술 스택](#기술-스택)
- [아키텍처](#아키텍처)
- [시작하기](#시작하기)
- [초기 설정](#초기-설정)
- [MariaDB 설정](#mariadb-설정)

---

## 프로젝트 소개

WIZ550S2E는 시리얼 장비를 TCP/IP 네트워크에 연결해 주는 모듈이다.<br/>
이 모듈을 통해 전원 제어 장비(멀티탭)를 네트워크에 연결하면<br/>
원격에서 채널별 전원을 켜고 끌 수 있지만,<br/>
장비가 여러 대일 경우 하나씩 직접 접속해 제어해야 한다는 한계가 있다.<br/>

이 프로젝트는 여러 대의 WIZ550S2E 장비를 웹 브라우저 하나로 통합 관리하는 서버 프로그램이다.<br/>
장비 목록을 등록하면 TCP로 자동 연결되고, 실시간 상태 모니터링과 채널별 전원 제어가 가능하다.<br/>
Node.js 단일 프로세스로 HTTP 서버·WebSocket·TCP 통신을 모두 처리하며,<br/>
별도 설치 없이 바로 실행 가능한 EXE 파일로 배포된다.<br/>

---

## 주요 기능

- **전원 제어** — 채널별 ON / OFF / RESET, 전체 채널 일괄 제어
- **다중 장비 선택** — 여러 장비를 한 번에 선택해 동시 제어
- **실시간 모니터링** — WebSocket 기반, 10초 주기 자동 상태 갱신
- **연결 상태 4단계** — 연결됨 / 타임아웃 / 연결 끊김 / 미연결
- **패킷 로그** — 송수신 패킷 실시간 표시, 필터·상세 보기 지원
- **DB 로그 기록** — MariaDB 연동 시 이력 저장 / 검색 / CSV 내보내기
- **사용자 관리** — 관리자·일반 사용자 역할 구분, 다중 계정 지원
- **설정 백업·복원** — 장비 목록·서버 설정을 JSON 파일로 백업
- **HTTPS** — OpenSSL 자동 인증서 생성, 브라우저 설치 안내 포함

---

## 기술 스택

### Backend
[![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![mysql2](https://img.shields.io/badge/mysql2-4479A1?style=for-the-badge&logo=mysql&logoColor=white)](https://github.com/sidorares/node-mysql2)

### Frontend
[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=for-the-badge&logo=html5&logoColor=white)]()
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=for-the-badge&logo=css3&logoColor=white)]()
[![JavaScript](https://img.shields.io/badge/Vanilla%20JS-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)]()
[![WebSocket](https://img.shields.io/badge/WebSocket-010101?style=for-the-badge&logo=socket.io&logoColor=white)]()

### Database
[![MariaDB](https://img.shields.io/badge/MariaDB-003545?style=for-the-badge&logo=mariadb&logoColor=white)](https://mariadb.org/)

### 통신 프로토콜
[![TCP](https://img.shields.io/badge/TCP%20Socket-00599C?style=for-the-badge&logo=cisco&logoColor=white)]()
[![HTTPS](https://img.shields.io/badge/HTTPS-FF6B35?style=for-the-badge&logo=letsencrypt&logoColor=white)]()

### 배포
[![pkg](https://img.shields.io/badge/pkg%20(EXE%20빌드)-CB3837?style=for-the-badge&logo=npm&logoColor=white)](https://github.com/vercel/pkg)
[![Windows](https://img.shields.io/badge/Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)]()

---

## 아키텍처

```
브라우저 (HTTPS / WebSocket)
    │
    ▼
┌─────────────────────────────┐
│        Node.js 서버          │
│                             │
│  HTTP API  ─  세션/인증      │
│  WebSocket ─  실시간 푸시    │
│  TCP 서버  ─  장비 통신      │
│                             │
│  devices.json  config.json  │ ← 로컬 파일 (설정·장비 목록)
└──────────────┬──────────────┘
               │ TCP (기본 5002)
    ┌──────────┴──────────┐
    │  WIZ550S2E 장비들   │
    │  (전원 제어 멀티탭)  │
    └─────────────────────┘
         (MariaDB — 선택)
```

### 기본 포트

| 용도 | 포트 |
|------|------|
| 웹 접속 (HTTPS) | `3000` |
| 장비 TCP 통신 | `5002` |

TCP 포트는 웹 설정 화면에서 변경 가능하다.

---

## 시작하기

### 사전 요구사항

- Windows 운영체제
- (선택) [MariaDB](https://mariadb.org/download) — 로그 저장 기능 사용 시 필요

### 실행

배포받은 `dist` 폴더를 원하는 위치에 놓고 `start.bat` 을 더블클릭한다.

```
dist/
├── DeviceManager.exe   ← 서버 본체 (Node.js 설치 불필요)
└── start.bat           ← 더블클릭으로 실행
```

서버가 켜지면 브라우저에서 접속한다.

```
https://localhost:3000
```

> **"연결이 안전하지 않습니다" 경고**가 뜨면 **고급 → 계속 진행** 으로 일단 접속한 뒤,
> 화면의 **인증서 설치** 안내를 따르면 다음부터 경고가 사라진다.

### 개발 환경 실행

```bash
cd source
npm install
node server.js
```

### EXE 빌드

[Node.js](https://nodejs.org/) 18 이상이 설치된 상태에서 루트 폴더의 `make_dist.bat` 을 실행한다.

```
make_dist.bat
  → npm install
  → pkg 빌드
  → dist/DeviceManager.exe 생성
```

---

## 초기 설정

서버 최초 실행 시 기본 계정이 자동 생성된다.

| 항목 | 값 |
|------|-----|
| 아이디 | `admin` |
| 비밀번호 | `admin1234` |

> 로그인 후 반드시 비밀번호를 변경한다.
> 우측 상단 **설정 → 사용자 관리** 에서 변경 가능하다.

로그인하면 시작 가이드가 자동으로 표시된다. 아래 순서로 진행한다.

| 순서 | 항목 | 필수 여부 |
|------|------|-----------|
| 1 | **장비 등록** — 제어할 WIZ550S2E 장비 추가 | 필수 |
| 2 | **DB 설정** — 로그 기록을 위한 MariaDB 연결 | 선택 |
| 3 | **인증서 설치** — 브라우저 HTTPS 경고 제거 | 권장 |

---

## MariaDB 설정

로그를 저장하고 검색하려면 MariaDB가 필요하다.
없어도 서버는 정상 동작하며, 실시간 모니터링은 가능하다.

### 설치

[https://mariadb.org/download](https://mariadb.org/download) 에서 다운로드 후 설치한다.
설치 중 **Root 비밀번호** 를 반드시 설정한다.

### 인증 방식 변경 (필수)

mysql2 라이브러리 호환을 위해 아래 SQL을 실행해야 한다.

```sql
ALTER USER 'root'@'localhost'
  IDENTIFIED VIA mysql_native_password
  USING PASSWORD('설정한_비밀번호');
FLUSH PRIVILEGES;
```

### 서버 연결 설정

웹 화면 우측 상단 **설정 → DB 설정** 에서 아래 정보를 입력한다.

```
호스트   : localhost
포트     : 3306
아이디   : root
비밀번호 : 위에서 설정한 비밀번호
DB명     : 원하는 이름 (예: device_log)
```

---

<div align="center">
  <sub>김민재 (kmj228)</sub>
</div>
