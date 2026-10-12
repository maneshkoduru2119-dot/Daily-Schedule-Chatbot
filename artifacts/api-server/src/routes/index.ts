import { Router, type IRouter } from "express";
import healthRouter from "./health";
import plannerRouter from "./planner";

const router: IRouter = Router();

router.use(healthRouter);
router.use(plannerRouter);

export default router;
