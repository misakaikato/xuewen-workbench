import asyncio, pathlib
from playwright.async_api import async_playwright
D = pathlib.Path(__file__).resolve().parent.parent
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path="/usr/bin/google-chrome")
        for k in "ABC":
            for i,s in enumerate(["read","ask","index"],1):
                pg = await b.new_page(viewport={"width":1440,"height":900}); await pg.goto(f"file://{D}/{k}.html#{s}"); await pg.wait_for_timeout(300)
                await pg.screenshot(path=str(D/f"{k}-{i}-{s}.png")); await pg.close()
        await b.close()
asyncio.run(main())
