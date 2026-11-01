import { Probot } from "probot";

export default (app: Probot) => {
  app.log.info("PR Review Bot loaded!");
};
