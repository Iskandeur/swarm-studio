"""Run Laya on your own machine so that Swarm Studio, a web page, can call it.

Laya (https://huggingface.co/convaiinnovations/laya, Apache-2.0) is an open-weight decision model
that speaks the same POST /v1/systemone protocol as TypeSafe's Jev. Its own server, laya-serve,
sends no CORS headers, so a browser refuses to read its answers. This runs the same app with CORS
open to the Swarm Studio origins, and binds to 127.0.0.1: laya-serve has no key by default, so it
should not listen on the network.

    pip install "laya[serve]"
    python tools/laya-serve-cors.py        # -> http://127.0.0.1:8000/v1/systemone

The first start downloads the weights (about 0.8 GB for English, 0.65 GB for multilingual) into the
Hugging Face cache; later starts take a few seconds. It runs on a CPU, faster on a GPU
(LAYA_DEVICE=cuda).

Environment: every LAYA_* variable laya-serve reads (LAYA_DEVICE, LAYA_THREADS, LAYA_API_KEY, ...),
plus:
  LAYA_HOST        bind address, default 127.0.0.1 (laya-serve's own default is 0.0.0.0)
  LAYA_PORT        default 8000
  LAYA_MODELS      checkpoints loaded at start, default "english,multilingual" (the two the router
                   picks between; "typed-decisions" still loads on the first request that names it)
  SWARM_ORIGINS    comma list of allowed origins, replacing the defaults below
"""
import os

os.environ.setdefault("USE_TF", "0")  # laya's own advice: TensorFlow's import can deadlock model loading
os.environ.setdefault("LAYA_MODELS", "english,multilingual")

DEFAULT_ORIGINS = [
    "https://iskandeur.github.io",  # the published Swarm Studio
    "http://localhost:5173",  # npm run dev
    "http://127.0.0.1:5173",
    "http://localhost:4173",  # npm run preview
    "http://127.0.0.1:4173",
]


def origins():
    raw = os.environ.get("SWARM_ORIGINS", "").strip()
    return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()] if raw else DEFAULT_ORIGINS


class PrivateNetworkAccess:
    """Answers Chrome's Private Network Access preflight (a public page calling 127.0.0.1).

    Older Chromium sent `Access-Control-Request-Private-Network: true` on the preflight and wanted the
    same word back. Chrome 142+ asks the user instead (Local Network Access) and no longer sends it:
    Chrome 153 did not, on 2026-09-25. The answer is kept for older browsers, harmless elsewhere.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "OPTIONS":
            return await self.app(scope, receive, send)
        asked = any(k.lower() == b"access-control-request-private-network" for k, _ in scope["headers"])

        async def send_with_pna(message):
            if asked and message["type"] == "http.response.start":
                message["headers"] = list(message.get("headers", [])) + [
                    (b"access-control-allow-private-network", b"true")
                ]
            await send(message)

        return await self.app(scope, receive, send_with_pna)


def build():
    import inspect

    from fastapi.middleware.cors import CORSMiddleware
    from laya.serve import create_app

    app = create_app()
    options = dict(
        allow_origins=origins(),
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["authorization", "content-type"],
        max_age=600,
    )
    # Recent Starlette (1.7 when this was written) handles the Private Network preflight itself, and
    # REFUSES it (400 "Disallowed CORS private-network") unless told otherwise. Versions without the
    # option ignore the header, and then the wrapper below adds the answer.
    if "allow_private_network" in inspect.signature(CORSMiddleware.__init__).parameters:
        app.add_middleware(CORSMiddleware, allow_private_network=True, **options)
        return app
    app.add_middleware(CORSMiddleware, **options)
    return PrivateNetworkAccess(app)


def main():
    import uvicorn

    host = os.environ.get("LAYA_HOST", "127.0.0.1")
    port = int(os.environ.get("LAYA_PORT", "8000"))
    print("Laya for Swarm Studio: http://%s:%d/v1/systemone (origins: %s)" % (host, port, ", ".join(origins())))
    uvicorn.run(build(), host=host, port=port, log_level=os.environ.get("LAYA_LOG_LEVEL", "info"))


if __name__ == "__main__":
    main()
