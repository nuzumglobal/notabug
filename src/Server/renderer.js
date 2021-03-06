import React from "react";
import * as R from "ramda";
import { StaticRouter as Router, matchPath } from "react-router-dom";
import { renderToString } from "react-dom/server";
import init from "@notabug/peer";
import serialize from "serialize-javascript";
import { App } from "/App";
import { routes } from "/Routing";
import { options } from "./options";

const Gun = (global.Gun = require("gun/gun"));

const serializeState = (data = {}) => `
<script type="text/javascript">
window.initNabState = ${serialize(data, { isJSON: true })};
</script>
`;

export default (nab, req, res) =>
  require("fs").readFile(
    require("path").resolve(__dirname, "..", "htdocs", "index.html"),
    "utf8",
    async (err, htmlData) => {
      if (err) return console.error("err", err) || res.status(500).end();
      let routeMatch;
      const isJson = /\.json$/.test(req.path);
      const urlpath = (isJson
        ? req.path.replace(/\.json$/, "")
        : req.path
      ).replace(/^\/api/, "");
      const url = isJson ? req.url.replace(req.path, urlpath) : req.url;
      const route = routes.find(
        route => (routeMatch = matchPath(urlpath, route))
      );

      if (!route) return res.status(404).end();
      const notabugApi = init(Gun, {
        noGun: true,
        localStorage: false,
        disableValidation: true
      });
      let getter;
      if (nab.gun.redis) getter = nab.gun.redis.read;
      if (nab.gun.lmdb) getter = nab.gun.lmdb.read.bind(nab.gun.lmdb);
      const scope = (notabugApi.scope = nab.newScope({
        noGun: !!options.redis || options.lmdb,
        onlyOnce: true,
        getter,
        timeout: 1000
      }));

      try {
        if (route.withMatch) {
          await route
            .withMatch(R.assoc("query", req.query, routeMatch))
            .preload(scope);
        }
        const data = scope.getGraph();
        const props = { context: {}, location: url };
        const html = renderToString(
          <Router {...props}>
            <App {...{ notabugApi }} />
          </Router>
        );

        if (isJson) return res.send(data);
        const parts = htmlData.split("!!!CONTENT!!!");
        const result = [parts[0], html, serializeState(data), parts[1]].join(
          ""
        );

        return res.send(result);
      } catch (e) {
        console.error("error generating page", url, (e && e.stack) || e);
        return res.send(
          htmlData.replace(
            "!!!CONTENT!!!",
            "<noscript>Something Broke</noscript>"
          )
        );
      }
    }
  );
