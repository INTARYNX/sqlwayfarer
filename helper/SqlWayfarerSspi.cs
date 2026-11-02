// SQL Wayfarer - Windows integrated authentication helper.
//
// The Node driver (tedious) cannot use the SSPI token of the logged-on
// Windows account. This small console program can: it opens connections with
// System.Data.SqlClient ("Integrated Security=SSPI") and talks to the
// extension through JSON lines on stdin/stdout (see database/SspiPool.js for
// the other side of the protocol).
//
// It targets the .NET Framework that ships with Windows, so nothing has to be
// bundled, and it is built with the csc.exe found in %WINDIR%\Microsoft.NET
// (scripts/build-helper.ps1). That compiler only speaks C# 5: no string
// interpolation, no "?.", no expression-bodied members.
//
// Requests (one JSON object per line on stdin):
//   {"id":1,"op":"open","server":"..","port":1433,"database":"..","encrypt":true,"trustServerCertificate":true}
//   {"id":2,"op":"query","session":1,"sql":"..","params":[{"name":"p","type":"int","value":1}],"timeout":300000}
//   {"id":3,"op":"close","session":1}
//   {"op":"cancel","target":2}
//   {"op":"exit"}
//
// Replies (one JSON object per line on stdout), all carrying the request id:
//   {"id":2,"ev":"recordset","columns":[{"name":"a","type":"int","kind":"value"}]}
//   {"id":2,"ev":"rows","rows":[[1],[2]]}
//   {"id":2,"ev":"info","message":"..",...}      (severity <= 10)
//   {"id":2,"ev":"error","message":"..",...}     (severity > 10, the batch goes on)
//   {"id":2,"ev":"rowsaffected","count":3}
//   {"id":2,"end":true}                          (terminal, success)
//   {"id":2,"fail":{"message":"..",...}}         (terminal, the request itself failed)

using System;
using System.Collections.Generic;
using System.Data;
using System.Data.SqlClient;
using System.Globalization;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace SqlWayfarer
{
    internal sealed class Session
    {
        public SqlConnection Conn;
        // Written by the request thread, read by the cancel and message paths.
        public volatile SqlCommand Command;
        public volatile int CurrentRequest;

        // Severity > 10 is an error, anything else an informational message
        // (PRINT, RAISERROR with a low severity). The connection delivers both
        // here because FireInfoMessageEventOnUserErrors is on: the batch keeps
        // running after an error, the way the Node driver behaves.
        public void OnInfoMessage(object sender, SqlInfoMessageEventArgs e)
        {
            int id = CurrentRequest;
            if (id == 0) return;
            foreach (SqlError error in e.Errors)
            {
                Program.Send(Program.ErrorJson(id, error.Class > 10 ? "error" : "info", error));
            }
        }
    }

    internal static class Program
    {
        static readonly object OutLock = new object();
        static TextWriter Out;
        static readonly Dictionary<int, Session> Sessions = new Dictionary<int, Session>();
        static readonly HashSet<int> PendingCancels = new HashSet<int>();
        static int nextSession;
        const int RowsPerMessage = 500;
        const int CharsPerMessage = 256 * 1024;

        static int Main(string[] args)
        {
            Out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false), 65536);
            ((StreamWriter)Out).NewLine = "\n";
            StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            JavaScriptSerializer serializer = new JavaScriptSerializer();
            serializer.MaxJsonLength = int.MaxValue;

            string line;
            while ((line = input.ReadLine()) != null)
            {
                if (line.Length == 0) continue;
                Dictionary<string, object> message;
                try { message = (Dictionary<string, object>)serializer.DeserializeObject(line); }
                catch (Exception) { continue; }

                string op = Str(message, "op");
                if (op == "exit") break;
                if (op == "cancel") { Cancel(message); continue; }
                Dictionary<string, object> captured = message;
                Task.Run(() => Handle(captured));
            }

            // stdin closed (or exit requested): the extension is gone.
            CloseAll();
            return 0;
        }

        // ---- Dispatch -----------------------------------------------------

        static void Handle(Dictionary<string, object> message)
        {
            int id = Int(message, "id");
            try
            {
                switch (Str(message, "op"))
                {
                    case "open":
                        Open(id, message);
                        break;
                    case "close":
                        CloseSession(Int(message, "session"));
                        Send("{\"id\":" + id + ",\"end\":true}");
                        break;
                    case "query":
                        RunQuery(id, message);
                        break;
                    default:
                        throw new InvalidOperationException("Unknown operation");
                }
            }
            catch (Exception ex)
            {
                Send(FailJson(id, ex));
            }
        }

        static void Open(int id, Dictionary<string, object> message)
        {
            SqlConnectionStringBuilder builder = new SqlConnectionStringBuilder();
            string server = Str(message, "server");
            object port = Get(message, "port");
            builder.DataSource = port != null
                ? server + "," + Convert.ToString(port, CultureInfo.InvariantCulture)
                : server;
            string database = Str(message, "database");
            if (!string.IsNullOrEmpty(database)) builder.InitialCatalog = database;
            builder.IntegratedSecurity = true;
            object encrypt = Get(message, "encrypt");
            if (encrypt != null) builder.Encrypt = Convert.ToBoolean(encrypt);
            object trust = Get(message, "trustServerCertificate");
            if (trust != null) builder.TrustServerCertificate = Convert.ToBoolean(trust);
            builder.ApplicationName = "SQL Wayfarer";
            builder.ConnectTimeout = 15;

            Session session = new Session();
            session.Conn = new SqlConnection(builder.ConnectionString);
            session.Conn.FireInfoMessageEventOnUserErrors = true;
            session.Conn.InfoMessage += session.OnInfoMessage;
            try
            {
                session.Conn.Open();
            }
            catch (Exception)
            {
                session.Conn.Dispose();
                throw;
            }

            int sessionId = Interlocked.Increment(ref nextSession);
            lock (Sessions) { Sessions[sessionId] = session; }
            Send("{\"id\":" + id + ",\"end\":true,\"session\":" + sessionId + "}");
        }

        static void CloseSession(int sessionId)
        {
            Session session;
            lock (Sessions)
            {
                if (!Sessions.TryGetValue(sessionId, out session)) return;
                Sessions.Remove(sessionId);
            }
            try { session.Conn.Dispose(); } catch (Exception) { }
        }

        static void CloseAll()
        {
            List<int> ids;
            lock (Sessions) { ids = new List<int>(Sessions.Keys); }
            foreach (int sessionId in ids) CloseSession(sessionId);
        }

        static void Cancel(Dictionary<string, object> message)
        {
            int target = Int(message, "target");
            Session found = null;
            lock (Sessions)
            {
                foreach (Session session in Sessions.Values)
                {
                    if (session.CurrentRequest == target) { found = session; break; }
                }
            }
            if (found == null)
            {
                // The request has not started yet: remember to refuse it.
                lock (PendingCancels) { PendingCancels.Add(target); }
                return;
            }
            SqlCommand command = found.Command;
            if (command == null) return;
            try { command.Cancel(); } catch (Exception) { }
        }

        // ---- Query --------------------------------------------------------

        static void RunQuery(int id, Dictionary<string, object> message)
        {
            Session session;
            lock (Sessions)
            {
                if (!Sessions.TryGetValue(Int(message, "session"), out session))
                    throw new InvalidOperationException("The connection is closed");
            }
            lock (PendingCancels)
            {
                if (PendingCancels.Remove(id))
                    throw new OperationCanceledException("Operation cancelled by user.");
            }

            // After a network failure or a server restart the connection is
            // closed or broken: open it again instead of failing every
            // following query. (The database context is back to the default,
            // which is why the extension prefixes its queries with USE.)
            if (session.Conn.State != ConnectionState.Open)
            {
                try { session.Conn.Close(); } catch (Exception) { }
                session.Conn.Open();
            }

            using (SqlCommand command = session.Conn.CreateCommand())
            {
                command.CommandText = Str(message, "sql");
                object timeout = Get(message, "timeout");
                int timeoutMs = timeout == null ? 0 : Convert.ToInt32(timeout, CultureInfo.InvariantCulture);
                command.CommandTimeout = timeoutMs <= 0 ? 0 : Math.Max(1, (timeoutMs + 999) / 1000);
                AddParameters(command, message);
                command.StatementCompleted += delegate(object sender, StatementCompletedEventArgs e)
                {
                    if (e.RecordCount >= 0)
                        Send("{\"id\":" + id + ",\"ev\":\"rowsaffected\",\"count\":" + e.RecordCount + "}");
                };

                session.Command = command;
                session.CurrentRequest = id;
                try
                {
                    using (SqlDataReader reader = command.ExecuteReader())
                    {
                        ReadResults(id, reader);
                    }
                }
                finally
                {
                    session.CurrentRequest = 0;
                    session.Command = null;
                }
            }
            Send("{\"id\":" + id + ",\"end\":true}");
        }

        static void ReadResults(int id, SqlDataReader reader)
        {
            do
            {
                int count = reader.FieldCount;
                if (count == 0) continue;

                Send(RecordsetJson(id, reader));

                StringBuilder batch = new StringBuilder();
                int rows = 0;
                while (reader.Read())
                {
                    if (rows == 0) batch.Append("{\"id\":").Append(id).Append(",\"ev\":\"rows\",\"rows\":[");
                    else batch.Append(',');
                    batch.Append('[');
                    for (int i = 0; i < count; i++)
                    {
                        if (i > 0) batch.Append(',');
                        AppendValue(batch, reader, i);
                    }
                    batch.Append(']');
                    rows++;
                    if (rows >= RowsPerMessage || batch.Length >= CharsPerMessage)
                    {
                        batch.Append("]}");
                        Send(batch.ToString());
                        batch.Length = 0;
                        rows = 0;
                    }
                }
                if (rows > 0)
                {
                    batch.Append("]}");
                    Send(batch.ToString());
                }
            } while (reader.NextResult());
        }

        static string RecordsetJson(int id, SqlDataReader reader)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"id\":").Append(id).Append(",\"ev\":\"recordset\",\"columns\":[");
            for (int i = 0; i < reader.FieldCount; i++)
            {
                if (i > 0) sb.Append(',');
                string typeName = "";
                try { typeName = reader.GetDataTypeName(i); } catch (Exception) { }
                Type fieldType = null;
                try { fieldType = reader.GetFieldType(i); } catch (Exception) { }
                // The JSON has no date or binary type: the kind tells the
                // extension what to turn the string back into.
                string kind = "value";
                if (fieldType == typeof(DateTime) || fieldType == typeof(DateTimeOffset) || fieldType == typeof(TimeSpan)) kind = "date";
                else if (fieldType == typeof(byte[])) kind = "binary";
                sb.Append("{\"name\":");
                AppendString(sb, reader.GetName(i));
                sb.Append(",\"type\":");
                AppendString(sb, typeName);
                sb.Append(",\"kind\":\"").Append(kind).Append("\"}");
            }
            sb.Append("]}");
            return sb.ToString();
        }

        static void AppendValue(StringBuilder sb, SqlDataReader reader, int i)
        {
            if (reader.IsDBNull(i)) { sb.Append("null"); return; }

            object value;
            try { value = reader.GetValue(i); }
            catch (Exception)
            {
                // CLR types (geography, hierarchyid) need assemblies that
                // are not guaranteed to be here: fall back to the raw bytes.
                value = reader.GetSqlBytes(i).Value;
            }

            if (value is string) AppendString(sb, (string)value);
            else if (value is bool) sb.Append((bool)value ? "true" : "false");
            else if (value is int || value is short || value is byte)
                sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
            // Like the Node driver, bigint stays a string: a double would lose digits.
            else if (value is long) AppendString(sb, ((long)value).ToString(CultureInfo.InvariantCulture));
            else if (value is decimal) sb.Append(((decimal)value).ToString(CultureInfo.InvariantCulture));
            else if (value is double) sb.Append(((double)value).ToString("R", CultureInfo.InvariantCulture));
            else if (value is float) sb.Append(((double)(float)value).ToString("R", CultureInfo.InvariantCulture));
            // The Node driver reads dates as UTC (its default), so the same here.
            else if (value is DateTime)
                AppendString(sb, DateTime.SpecifyKind((DateTime)value, DateTimeKind.Utc).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            else if (value is DateTimeOffset)
                AppendString(sb, ((DateTimeOffset)value).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture));
            else if (value is TimeSpan)
                AppendString(sb, "1970-01-01T" + ((TimeSpan)value).ToString(@"hh\:mm\:ss\.fff", CultureInfo.InvariantCulture) + "Z");
            else if (value is Guid) AppendString(sb, ((Guid)value).ToString().ToUpperInvariant());
            else if (value is byte[]) AppendString(sb, Convert.ToBase64String((byte[])value));
            else AppendString(sb, Convert.ToString(value, CultureInfo.InvariantCulture));
        }

        static void AddParameters(SqlCommand command, Dictionary<string, object> message)
        {
            object[] parameters = Get(message, "params") as object[];
            if (parameters == null) return;
            foreach (object item in parameters)
            {
                Dictionary<string, object> p = (Dictionary<string, object>)item;
                string name = Str(p, "name").TrimStart('@');
                object value = Get(p, "value");
                SqlParameter parameter;
                switch (Str(p, "type"))
                {
                    case "int":
                        parameter = new SqlParameter("@" + name, SqlDbType.Int);
                        parameter.Value = value == null ? (object)DBNull.Value : Convert.ToInt32(value, CultureInfo.InvariantCulture);
                        break;
                    case "bigint":
                        parameter = new SqlParameter("@" + name, SqlDbType.BigInt);
                        parameter.Value = value == null ? (object)DBNull.Value : Convert.ToInt64(value, CultureInfo.InvariantCulture);
                        break;
                    case "float":
                        parameter = new SqlParameter("@" + name, SqlDbType.Float);
                        parameter.Value = value == null ? (object)DBNull.Value : Convert.ToDouble(value, CultureInfo.InvariantCulture);
                        break;
                    case "bit":
                        parameter = new SqlParameter("@" + name, SqlDbType.Bit);
                        parameter.Value = value == null ? (object)DBNull.Value : Convert.ToBoolean(value);
                        break;
                    case "datetime":
                        parameter = new SqlParameter("@" + name, SqlDbType.DateTime2);
                        parameter.Value = value == null ? (object)DBNull.Value : DateTime.Parse(
                            Convert.ToString(value, CultureInfo.InvariantCulture), CultureInfo.InvariantCulture,
                            DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal);
                        break;
                    case "varbinary":
                        parameter = new SqlParameter("@" + name, SqlDbType.VarBinary);
                        parameter.Value = value == null ? (object)DBNull.Value : Convert.FromBase64String(Convert.ToString(value, CultureInfo.InvariantCulture));
                        break;
                    default:
                        parameter = new SqlParameter("@" + name, SqlDbType.NVarChar);
                        parameter.Value = value == null ? (object)DBNull.Value : Convert.ToString(value, CultureInfo.InvariantCulture);
                        break;
                }
                command.Parameters.Add(parameter);
            }
        }

        // ---- JSON output --------------------------------------------------

        public static void Send(string json)
        {
            lock (OutLock)
            {
                Out.WriteLine(json);
                Out.Flush();
            }
        }

        public static string ErrorJson(int id, string ev, SqlError error)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"id\":").Append(id).Append(",\"ev\":\"").Append(ev).Append("\",");
            AppendErrorFields(sb, error.Message, error.Number, error.State, error.Class, error.LineNumber, error.Procedure, error.Server);
            sb.Append('}');
            return sb.ToString();
        }

        static string FailJson(int id, Exception ex)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"id\":").Append(id).Append(",\"fail\":{");
            SqlException sql = ex as SqlException;
            if (sql != null && sql.Errors.Count > 0)
            {
                SqlError first = sql.Errors[0];
                AppendErrorFields(sb, sql.Message, sql.Number, first.State, first.Class, first.LineNumber, first.Procedure, first.Server);
            }
            else
            {
                AppendErrorFields(sb, ex.Message, 0, 0, 0, 0, null, null);
            }
            sb.Append("}}");
            return sb.ToString();
        }

        static void AppendErrorFields(StringBuilder sb, string message, int number, int state, int severity, int line, string procedure, string server)
        {
            sb.Append("\"message\":");
            AppendString(sb, message);
            sb.Append(",\"number\":").Append(number);
            sb.Append(",\"state\":").Append(state);
            sb.Append(",\"class\":").Append(severity);
            sb.Append(",\"lineNumber\":").Append(line);
            sb.Append(",\"procName\":");
            AppendString(sb, procedure ?? "");
            sb.Append(",\"serverName\":");
            AppendString(sb, server ?? "");
        }

        static void AppendString(StringBuilder sb, string value)
        {
            sb.Append('"');
            for (int i = 0; i < value.Length; i++)
            {
                char c = value[i];
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }

        // ---- Request field access -----------------------------------------

        static object Get(Dictionary<string, object> message, string key)
        {
            object value;
            return message.TryGetValue(key, out value) ? value : null;
        }

        static string Str(Dictionary<string, object> message, string key)
        {
            object value = Get(message, key);
            return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        static int Int(Dictionary<string, object> message, string key)
        {
            object value = Get(message, key);
            return value == null ? 0 : Convert.ToInt32(value, CultureInfo.InvariantCulture);
        }
    }
}
