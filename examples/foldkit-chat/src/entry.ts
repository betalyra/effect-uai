import { FetchHttpClient } from "effect/http"
import { Runtime } from "foldkit"
import { init, Model, subscriptions, update, view } from "./main"
import "./styles.css"

const application = Runtime.makeApplication({
  Model,
  init,
  update,
  view,
  subscriptions,
  resources: FetchHttpClient.layer,
  container: document.getElementById("root"),
})

Runtime.run(application)
