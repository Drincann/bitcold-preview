import { Switch, Route, Router as WouterRouter } from "wouter";
import TerminalPage from "@/pages/Terminal";

function App() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Switch>
        <Route path="/" component={TerminalPage} />
        <Route path="*" component={TerminalPage} />
      </Switch>
    </WouterRouter>
  );
}

export default App;
