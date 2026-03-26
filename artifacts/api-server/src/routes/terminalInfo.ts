import { Router, type IRouter } from "express";

const router: IRouter = Router();

router.get("/terminal/info", (req, res) => {
  const host = req.headers.host ?? "localhost";
  const protocol = req.secure ? "wss" : "ws";
  const wsUrl = `${protocol}://${host}/api/terminal`;
  res.json({
    wsUrl,
    tool: "bitcold",
    description:
      "A lightweight CLI for generating Bitcoin cold wallets, managing keys, and signing transactions offline.",
  });
});

export default router;
