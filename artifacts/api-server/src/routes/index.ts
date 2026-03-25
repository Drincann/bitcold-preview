import { Router, type IRouter } from "express";
import healthRouter from "./health";
import terminalInfoRouter from "./terminalInfo";

const router: IRouter = Router();

router.use(healthRouter);
router.use(terminalInfoRouter);

export default router;
