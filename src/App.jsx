import { useState, useEffect } from "react";
import "./App.css";
import getPostTitles from "./components/getPostTitles";
import Post from "./components/Post";
// import { get } from "http";
let postTitles = await getPostTitles();
let titles = [];

const handleCallback = () => {
  this.setState({ data: postTitles });
};

function App() {
  const [postTitles, setPostTitles] = useState([]);

  useEffect(() => {
    getPostTitles().then((response) => setPostTitles(response));
  }, []);

  return (
    <div className="App">
      <button className="NewPost" type="button" value="New">
        New
      </button>
      <h3>Posts</h3>
      <ul className="PostTitlesList">
        {postTitles.map((item, index) => (
          <div key={index}>{item}</div>
        ))}
      </ul>
    </div>
  );
}

export default App;
