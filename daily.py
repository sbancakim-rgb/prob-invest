"""매일 자동 실행(윈도우 작업 스케줄러가 평일 18:30에 실행).

1) run.py: 데이터 갱신 → 오늘의 추천 계산 (조합 검증은 7일마다 다시)
2) GitHub에 연결돼 있으면 결과(docs/data)를 올려 휴대폰 앱에 반영
기록은 logs/daily.log 에 남는다.
"""
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG = ROOT / "logs" / "daily.log"
# 창 없이 실행되는 pythonw.exe로 시작돼도 계산은 python.exe로 한다
PY = str(Path(sys.executable).with_name("python.exe"))


def main():
    LOG.parent.mkdir(exist_ok=True)
    with LOG.open("a", encoding="utf-8") as log:
        def run(cmd):
            log.write(f"$ {' '.join(cmd)}\n")
            log.flush()
            r = subprocess.run(cmd, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT,
                               env={**os.environ, "PYTHONIOENCODING": "utf-8"},
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            return r.returncode

        log.write(f"\n==== {datetime.now():%Y-%m-%d %H:%M:%S} 시작 ====\n")
        if run([PY, "-u", "run.py"]) != 0:
            log.write("[실패] run.py 오류\n")
            return 1
        if (ROOT / ".git").exists():
            run(["git", "add", "docs/data"])
            run(["git", "commit", "-m", f"오늘의 추천 갱신 {datetime.now():%Y-%m-%d}"])
            if run(["git", "push"]) != 0:
                log.write("[실패] GitHub 업로드 오류\n")
                return 1
        log.write(f"==== {datetime.now():%H:%M:%S} 끝 ====\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
