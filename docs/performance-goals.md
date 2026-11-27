# CareerProof의 성능 목표

한국어 지원자가 공고와 실제 경험으로 제출본을 만드는 과정에서 **각 전문 도구의 대표 과제를 그 도구보다 훨씬 잘 해결하는 것**을 제품 목표로 삼는다. PDF를 잘 읽는다는 주장, 공고와 잘 맞는다는 주장, 편집 시간을 줄인다는 주장에는 각각 다른 비교가 필요하다. 이번에 정한 수치는 다음 평가를 위한 **제안 목표**다.

## 무엇을 얼마나 개선할 것인가

| 비교 대상과 공통 과제 | 우위 목표 | 함께 통과할 조건 |
|---|---|---|
| **OpenResume** · 텍스트 PDF의 내용과 읽기 순서 복원 | 문서별 근거 문구 누락률을 상대적으로 50% 이상 감소 | 문구 복원율 98% 이상, 읽기 순서 정확도 98% 이상. 영문 단일 열·한글 다단·페이지 경계·이미지 전용을 구분한다. 이름·경력 등의 필드 추출은 별도 정답으로 측정한다. |
| **Resume Matcher** · 공고 요건과 지원자의 근거 대응 | 동일 요건에서 근거가 부족한데 충족으로 표시하는 오류를 상대적으로 50% 이상 감소 | 충족 요건 재현율 하락은 2%p 이내. 양쪽의 출력을 같은 판정표에 대응시킬 수 있을 때 평가한다. 근거 보존 재작성은 같은 모델·토큰 예산에서 새로 만들어 낸 주장과 보존된 사실을 별도로 센다. |
| **Reactive Resume** · 경험 가져오기, 수정, PDF 확정 | 같은 입력으로 올바른 제출본을 만드는 사용자 시간의 중앙값을 30% 이상 단축 | 원문 필수 사실 보존율 99% 이상, 잘못된 수치·누락·렌더링 실패도 함께 기록한다. 각 제품에 익숙해지는 시간을 주고 실행 순서를 교차한다. |
| **RenderCV** · 구조화 자료를 제출용 PDF로 변환 | 동일한 한글 자료에서 잘림·글자 유실·문단 순서 오류가 발생한 문서 비율을 상대적으로 50% 이상 감소 | 양 도구가 실제로 받은 필드와 사용 글꼴을 기록하고, 글자 추출과 렌더링된 페이지를 모두 검사한다. |
| **Fast-DetectGPT, Binoculars, KatFishNet, korean-ai-text-detection** · 한국어 자소서 저자 분류 연구 | 각 기준선 대비 동일 보류율·사람 글 FPR 5% 이하에서 AI 글 TPR을 10%p 이상 개선 | 창작·번역·편집 이력과 길이별 표본 수를 공개한다. 이 비교는 오프라인 연구 과제다. 제품의 3축 문체 지수는 편집 진단으로 유지하고, 사람 글에 대한 불필요한 경고율과 근거 있는 수정 제안을 따로 평가한다. |

기준선 오류가 0이면 상대 오류 감소율을 계산할 수 없다. 양쪽이 모두 완벽한 사례는 동률로 기록한다. 품질이 같은 상태에서 속도 우위를 조사할 때는 같은 장비에서 동일한 시작·종료 경계와 캐시 상태로 반복 실행한 p50·p95, 모델 호출 수, 입력·출력 토큰, 확인 가능한 비용을 보고한다. 자체 실행 시간과 상대 앱의 화면 갱신 시간으로 속도 배수를 계산하지 않는다.

## 언제 우위를 주장할 수 있는가

1. **비교 전에** 입력 분포, 주 지표, 보조 지표와 허용 회귀, 제외 사유, 모델·자원 예산을 고정한다. 모델을 공유할 수 없는 구성은 실제 제품 구성끼리 한 실험으로 표시한다.
2. 양쪽에 같은 원문과 허용 근거를 제공한다. 문서에 결과가 없거나 타임아웃이면 전체 모수에 남기고 실패·보류·미실행을 구분한다. 경쟁 제품이 제공하지 않는 기능은 기능 차이로 기록한다.
3. 가상 사례는 개발과 오류 재현에 쓴다. 공식 우위 판정에는 작성자가 겹치지 않는 동의·익명화 자료를 사용한다. 문서·작성자·레이아웃 단위로 개발 자료와 분리하고 입력 중복과 파생본을 점검한다. 한국어 실사용 표본과 원제품의 강점인 영문 대조군 결과를 각각 공개한다.
4. 비교 단위별 원시 결과를 짝지어 보관하고 작성자나 문서 단위로 묶은 95% 신뢰구간을 구한다. 목표 개선폭을 신뢰구간의 보수적인 끝에서도 충족하고 보조 조건을 통과한 범위에만 우위를 표시한다. 같은 자료에 여러 도구를 비교해 일괄 우위를 주장하려면 다중 비교도 보정한다.
5. 실행 코드 버전, 상대 버전 또는 배포 자산 지문, 평가셋 해시, 날짜, 환경, 실측과 미측정을 함께 기록한다. 문서·논문에 기재된 다른 데이터셋의 수치는 참고값으로 둔다.

프로젝트의 오픈소스별 역할과 공식 문서·라이선스 출처는 기존 조사에 정리했다. JSON Resume는 교환 형식, OpenDART는 공시 원자료 제공처이며 해당 연동은 호환성과 출처 보존으로 평가한다. [오픈소스 조사](careerproof-design-v0.2.2.md) · [이전 비교 기록](release-comparison.md)

## 2026년 11월 28일 측정 결과

### 공고 요건과 수행 근거

한국어 공고 한 줄과 가상의 사실 원장을 제품의 공고 파서와 매칭 함수에 입력했다. 같은 절에서 기술과 수행을 연결하고, 동료가 한 일·부정 표현을 구분한다. 단어만으로 판정하기 어려운 기간·역할·버전 조건은 원문 확인 대상으로 둔다. 평가 단위는 요건이며 세 등급의 F1을 같은 비중으로 평균했다.

| 자료 | 변경 전 → 변경 후 macro-F1 | 근거 부족을 충족으로 오인 | 실제 충족 요건을 찾은 수 |
|---|---:|---:|---:|
| 규칙 개발용 가상 자료 30건 | 0.675 → 1.000 | 11/21 → 0/21 | 8/9 → 9/9 |
| 독립 작성 가상 자료 24건 | 0.325 → 0.385 | 2/16 → 1/16 | 1/8 → 1/8 |

변경 전은 `339cf58`, 변경 후 판정 규칙은 `17e4c8c`이다. 독립 자료는 구현과 기존 사례를 보지 않은 별도 작성 모델이 정답과 이유를 고정했다. 실제로 충족한 PostgreSQL 튜닝과 Redis 캐시 경험은 시스템이 근거를 찾지 못했고, 계획 단계의 React 전환은 수행으로 잘못 인정했다. 다음 개선의 우선순위는 다양한 기술명과 수행 시제를 인식하면서 근거 없는 충족 판정을 줄이는 것이다. 공개한 24건은 이후 회귀 검사에 쓰고, 다음 일반화 평가는 새 자료로 실시한다. [개발 자료](../tests/fixtures/matching-benchmark.json) · [독립 평가와 항목별 근거](../tests/fixtures/matching-challenge.json)

### Resume Matcher와 기술어 언급 찾기

두 도구에 정규 기술어 하나와 같은 원문을 주고 그 기술을 언급했는지 물었다. 기술을 사용하지 않았다고 명시한 문장도 이 과제에서는 *언급*에 해당한다. Resume Matcher는 고정 커밋에서 실제 키워드 계산 함수와 그 의존 함수만 읽어 실행했고, CareerProof는 편집기에서 쓰는 기술어 추출 함수를 실행했다. 채용 공고 추출, 작성 모델, 종합 ATS 점수와 개인의 수행 근거 판정은 별도의 과제다. [Resume Matcher 계산 코드](https://github.com/srbhr/Resume-Matcher/blob/959e4587dab33d7ff849d822b8182e11e7669dfc/apps/backend/app/services/refiner.py#L778) · [문자열 비교 코드](https://github.com/srbhr/Resume-Matcher/blob/959e4587dab33d7ff849d822b8182e11e7669dfc/apps/backend/app/services/text_match.py)

| 가상 입력 32건 | CareerProof | Resume Matcher |
|---|---:|---:|
| 모든 항목의 정답 수 | 28/32 | 20/32 |
| 직접 표기 인식 | 10/10 | 10/10 |
| 별칭과 버전 표기 인식 | 10/10 | 0/10 |
| 기술 언급이 없는데 있다고 판정 | 4/12 | 2/12 |

CareerProof가 지원하는 어휘를 중심으로 고른 소표본이다. CareerProof는 문서형 데이터베이스 설명을 SQL로, 동영상의 TS를 TypeScript로 오인했다. 별칭 인식 이득과 동음이의어의 오탐이 같은 평가에서 관찰됐다. [전체 32건과 정답](../tests/fixtures/keyword-reference.json)

### OpenResume와 PDF 내용 복원

영문 단일 열, 한국어 기술 서술, 두 열, 두 페이지, 기술 기호, 이미지 전용 등 여섯 파일을 생성해 두 제품에 같은 바이트를 제공했다. OpenResume는 공개 배포본의 파싱 2단계에 표시되는 줄을, CareerProof는 로컬 추출기의 페이지별 미리보기를 읽었다. 공개 파서의 예시를 로드한 뒤 브라우저를 오프라인으로 바꾸고 매 파일을 새 브라우저 컨텍스트에서 열었다. Chrome 158.0.8127.38, 파서 자산 `page-0466c57ad89e3226.js`, CareerProof 추출기는 Windows Xpdf 4.06이었다. [공개 파서](https://www.open-resume.com/resume-parser) · [파일별 해시와 관측 기록](../tests/fixtures/openresume-observed/capture.json)

| 사전 지정 항목 | CareerProof | OpenResume |
|---|---:|---:|
| 근거 문구 복원 | 18/18 | 18/18 |
| 지정된 앞뒤 순서 복원 | 11/11 | 11/11 |
| 텍스트 PDF 토큰 정밀도·재현율 | 5건 모두 100% | 5건 모두 100% |
| 이미지 전용 1건 | 추출 텍스트 없음 | 추출 텍스트 없음 |

두 열 사이의 전체 읽기 순서는 정답으로 지정하지 않았다. 다중 페이지 자료에서 OpenResume는 첫 페이지 마지막 문장과 다음 페이지 제목을 한 줄로 표시했고 CareerProof는 두 페이지를 분리해 반환했다. 이 관찰은 위 표의 우열 판정에 사용하지 않았다. 이미지에 적힌 문구의 OCR과 이름·경력 필드 분류도 별도 과제다. [다중 페이지의 실제 캡처](../tests/fixtures/openresume-observed/04_multipage.txt)

### CareerProof 내부 매칭 시간

각 근거에서 기술별 수행 표현을 한 번만 계산하도록 바꿨다. 상대 제품과의 시간 비교는 아직 없다. Windows 11, Intel i5-1135G7, Node 26.13.1에서 이전 구현과 현재 구현을 같은 프로세스에서 교대로 호출했다. 워밍업 8쌍 뒤 40쌍을 측정했고 정렬 전 전체 반환 객체가 동일한지 확인했다. 생성한 가상 부하에서 매칭 함수만 잰 값이다.

| 공고 요건 × 사실 | 이전 p50 → 현재 p50 | 이전 p95 → 현재 p95 |
|---|---:|---:|
| 4 × 12 | 0.075 → 0.068 ms | 0.207 → 0.153 ms |
| 25 × 120 | 1.717 → 0.591 ms | 2.572 → 1.054 ms |

### 재현

저장소 루트에서 실행한다. 기존 버전과의 시간 비교에는 `17e4c8c`를 포함한 Git 이력이 필요하다. PDF는 `pdftotext`가 설치된 환경에서 생성·추출한다. 경로 `../careerproof-pdf-eval`은 생성물 전용 디렉터리로 사용한다.

```sh
node scripts/benchmark-matching.mjs --dataset development
node scripts/benchmark-matching.mjs --dataset challenge
git worktree add --detach ../careerproof-before-matching 339cf58
node scripts/benchmark-matching.mjs --dataset challenge --module ../careerproof-before-matching/frontend/research.js
node scripts/benchmark-matching.mjs --dataset development --module ../careerproof-before-matching/frontend/research.js
node scripts/benchmark-matching-runtime.mjs
python scripts/benchmark_pdf.py --output-dir ../careerproof-pdf-eval --external-dir tests/fixtures/openresume-observed
```

Resume Matcher는 아래 커밋을 포함한 로컬 저장소를 제공하면 두 파일의 해시를 검증한 뒤 비교한다. PDF를 새로 관측하려면 기존 Chrome과 Playwright 설치를 사용해 마지막 명령으로 새 디렉터리에 캡처한다. 공개 배포본이 바뀌면 관측 시각과 자산 이름도 함께 기록된다.

```sh
git clone https://github.com/srbhr/Resume-Matcher.git ../resume-matcher-reference
python scripts/benchmark-keyword-reference.py --resume-matcher ../resume-matcher-reference
node scripts/capture-openresume.mjs ../careerproof-pdf-eval ../openresume-new-capture /path/to/playwright/index.mjs
```

Reactive Resume의 실제 편집 시간, RenderCV의 한국어 출력, 탐지기 4종의 한국어 자소서 저오탐 성능은 아직 직접 비교하지 않았다. 편집 시간에는 같은 사람이 수행하는 교차 실험이, 탐지기 비교에는 사용 동의와 저자·편집 이력을 확인한 평가셋이 필요하다.
