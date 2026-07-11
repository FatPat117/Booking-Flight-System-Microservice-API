import { createApp } from "./app.js";


const app = createApp();
const PORT = 3000;


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
